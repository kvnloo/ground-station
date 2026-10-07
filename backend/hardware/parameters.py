# Copyright (c) 2025 Efstratios Goudelis
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""SDR capability probing and the shared in-process capability cache."""

import asyncio
import json
import logging
import math
import sys
from bisect import bisect_left
from typing import Any, Dict, Optional, Union

import crud
from session.store import active_sdr_clients
from workers.common import window_functions

logger = logging.getLogger("sdr-parameters")

# Locks are shared by browser probes and worker startup in the server process.
sdr_parameters_cache: Dict[tuple[str, str], Dict] = {}
_sdr_parameter_locks: Dict[str, asyncio.Lock] = {}


def sdr_parameter_lock(sdr_id: str) -> asyncio.Lock:
    return _sdr_parameter_locks.setdefault(str(sdr_id), asyncio.Lock())


def _cache_key(sdr_id: str, recording_path: Optional[str] = None) -> tuple[str, str]:
    return (str(sdr_id), str(recording_path or "") if str(sdr_id) == "sigmf-playback" else "")


def get_cached_sdr_parameters(sdr_id: str, recording_path: Optional[str] = None) -> Optional[Dict]:
    return sdr_parameters_cache.get(_cache_key(sdr_id, recording_path))


def invalidate_sdr_parameters(sdr_id: str) -> None:
    for key in [key for key in sdr_parameters_cache if key[0] == str(sdr_id)]:
        del sdr_parameters_cache[key]


def _decode_subprocess_output(raw: Optional[bytes]) -> str:
    if not raw:
        return ""
    return raw.decode(errors="replace").strip()


async def _communicate_probe(process, timeout):
    """Reap a timed-out or canceled probe before the SDR startup gate opens."""
    try:
        return await asyncio.wait_for(process.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise


def _nearest_rate(sorted_rates: list[float], target: float) -> float:
    if not sorted_rates:
        return target
    idx = bisect_left(sorted_rates, target)
    if idx <= 0:
        return sorted_rates[0]
    if idx >= len(sorted_rates):
        return sorted_rates[-1]
    before = sorted_rates[idx - 1]
    after = sorted_rates[idx]
    return after if abs(after - target) < abs(target - before) else before


def _select_neat_sample_rates(rates: list[float]) -> list[float]:
    clean_rates = sorted({float(r) for r in rates if r and r > 0})
    if len(clean_rates) <= 50:
        return clean_rates

    min_rate = clean_rates[0]
    max_rate = clean_rates[-1]
    log_min = math.log10(min_rate)
    log_max = math.log10(max_rate)

    selected: set[float] = set()
    targets: list[float] = []
    for exp in range(int(math.floor(log_min)), int(math.ceil(log_max)) + 1):
        for base in (1.0, 2.0, 2.5, 5.0):
            target = base * (10**exp)
            if min_rate <= target <= max_rate:
                targets.append(target)

    for target in targets:
        nearest = _nearest_rate(clean_rates, target)
        tolerance = max(target * 0.01, 1.0)
        if abs(nearest - target) <= tolerance:
            selected.add(nearest)

    selected.add(min_rate)
    selected.add(max_rate)

    if len(selected) < 20:
        for i in range(20):
            target = 10 ** (log_min + (log_max - log_min) * (i / 19))
            selected.add(_nearest_rate(clean_rates, target))

    return sorted(selected)


def _strip_sample_rate_ranges(capabilities: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(capabilities, dict):
        return capabilities
    sanitized = dict(capabilities)
    sanitized.pop("sample_rate_ranges", None)
    return sanitized


async def probe_sdr_parameters(dbsession, sdr_id, timeout=30.0, recording_path=None):
    """Probe a device under its capability lock, reusing an exact cache entry."""

    reply: Dict[str, Union[bool, None, dict, list, str]] = {
        "success": None,
        "data": None,
        "error": None,
    }
    sdr = {}
    sdr_params = {}

    if sdr_id == "sigmf-playback" and not recording_path:
        for session in active_sdr_clients.values():
            if session.get("sdr_id") == sdr_id:
                recording_path = session.get("recording_path", "")
                break
    cache_key = _cache_key(sdr_id, recording_path)
    # Playback capabilities depend on the selected recording, not just the SDR ID.
    if cache_key in sdr_parameters_cache:
        logger.info("Using cached parameters for SDR with id %s", sdr_id)
        return {"success": True, "data": sdr_parameters_cache[cache_key]}

    try:
        # Handle hardcoded SigMF playback SDR
        if sdr_id == "sigmf-playback":
            sdr = {
                "id": "sigmf-playback",
                "name": "SigMF Playback",
                "type": "sigmfplayback",
                "driver": "sigmfplayback",
                "recording_path": recording_path or "",
            }
        else:
            # Fetch SDR device details from database
            sdr_device_reply = await crud.hardware.fetch_sdr(dbsession, sdr_id)

            if not sdr_device_reply["data"]:
                raise Exception(f"SDR device with id {sdr_id} not found in database")

            sdr = sdr_device_reply["data"]

        if sdr.get("type") in ["rtlsdrtcpv3", "rtlsdrusbv3", "rtlsdrtcpv4", "rtlsdrusbv4"]:

            # Common RTL-SDR gain values in dB
            gain_values = [
                0.0,
                0.9,
                1.4,
                2.7,
                3.7,
                7.7,
                8.7,
                12.5,
                14.4,
                15.7,
                16.6,
                19.7,
                20.7,
                22.9,
                25.4,
                28.0,
                29.7,
                32.8,
                33.8,
                36.4,
                37.2,
                38.6,
                40.2,
                42.1,
                43.4,
                43.9,
                44.5,
                48.0,
            ]

            # Common RTL-SDR sample rates in Hz
            sample_rate_values = [
                240000,
                300000,
                960000,
                1024000,
                1536000,
                1792000,
                1920000,
                2048000,
                2304000,
                2400000,
                2560000,
                2880000,
                3200000,
            ]

            # Common window functions
            window_function_names = list(window_functions.keys())

            # Common FFT sizes
            fft_size_values = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

            params = {
                "gain_values": gain_values,
                "sample_rate_values": sample_rate_values,
                "fft_size_values": fft_size_values,
                "fft_window_values": window_function_names,
                "has_bias_t": True,
                "has_tuner_agc": True,
                "has_rtl_agc": True,
                "antennas": {"tx": [], "rx": ["RX"]},
            }

            sdr_parameters_cache[cache_key] = params
            reply = {"success": True, "data": params}

        elif sdr.get("type") in ["airspy", "airspyhf"]:
            logger.info("Getting SDR parameters from native Airspy backend for SDR: %s", sdr)
            probe_process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                "from hardware.airspyprobe import probe_native_airspy; "
                "import json; "
                f"print(json.dumps(probe_native_airspy({sdr})))",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await _communicate_probe(probe_process, timeout)
                if probe_process.returncode != 0:
                    error_output = _decode_subprocess_output(stderr)
                    raise Exception(f"Native Airspy probe process failed: {error_output}")
            except asyncio.TimeoutError:
                raise TimeoutError("Timed out while getting SDR parameters from native Airspy")

            sdr_params_reply = json.loads(_decode_subprocess_output(stdout))
            if sdr_params_reply.get("success") is False:
                logger.error(sdr_params_reply)
                raise Exception(sdr_params_reply.get("error") or "Native Airspy probe failed")

            sdr_params = sdr_params_reply.get("data", {})
            for log_line in sdr_params_reply.get("log", []):
                logger.debug(log_line)

            window_function_names = list(window_functions.keys())
            fft_size_values = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

            params = {
                "gain_values": sdr_params.get("gains", []),
                "sample_rate_values": _select_neat_sample_rates(sdr_params.get("rates", [])),
                "sample_rate_values_full": sdr_params.get("rates", []),
                "fft_size_values": fft_size_values,
                "fft_window_values": window_function_names,
                "has_bias_t": sdr_params.get("has_bias_t", False),
                "has_tuner_agc": sdr_params.get("has_tuner_agc", False),
                "has_rtl_agc": False,
                "has_soapy_agc": False,
                "antennas": sdr_params.get("antennas", {"tx": [], "rx": ["RX"]}),
                "frequency_ranges": sdr_params.get("frequency_ranges", {}),
                "clock_info": sdr_params.get("clock_info", {}),
                "temperature": sdr_params.get("temperature", {}),
                "capabilities": sdr_params.get("capabilities", {}),
            }

            sdr_parameters_cache[cache_key] = params
            reply = {"success": True, "data": params}

        elif sdr.get("type") in ["soapysdrremote", "soapysdrlocal"]:
            if sdr.get("type") == "soapysdrremote":
                logger.info("Getting SDR parameters from SoapySDR server for SDR: %s", sdr)
                probe_process = await asyncio.create_subprocess_exec(
                    "python3",
                    "-c",
                    "from hardware.soapysdrremoteprobe import probe_remote_soapy_sdr; "
                    f"print(probe_remote_soapy_sdr({sdr}))",
                    stdout=asyncio.subprocess.PIPE,
                )

                try:
                    stdout, _ = await _communicate_probe(probe_process, timeout)

                except asyncio.TimeoutError:
                    raise TimeoutError(
                        "Timed out while getting SDR parameters from SoapySDR server"
                    )
            else:
                logger.info("Getting SDR parameters from local SoapySDR for SDR: %s", sdr)
                probe_process = await asyncio.create_subprocess_exec(
                    "python3",
                    "-c",
                    "from hardware.soapysdrlocalprobe import probe_local_soapy_sdr; "
                    f"print(probe_local_soapy_sdr({sdr}))",
                    stdout=asyncio.subprocess.PIPE,
                )

                try:
                    stdout, _ = await _communicate_probe(probe_process, timeout)

                except asyncio.TimeoutError:
                    raise TimeoutError(
                        "Timed out while getting SDR parameters from SoapySDR server"
                    )

            sdr_params_reply = eval(stdout.decode().strip())

            if sdr_params_reply["success"] is False:
                logger.error(sdr_params_reply)
                raise Exception(sdr_params_reply["error"])

            sdr_params = sdr_params_reply["data"]

            logger.debug("Got SDR parameters from SoapySDR server: %s", sdr_params)
            for log_line in sdr_params_reply["log"]:
                logger.debug(log_line)

            window_function_names = list(window_functions.keys())
            fft_size_values = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

            params = {
                "gain_values": sdr_params["gains"],
                "sample_rate_values": _select_neat_sample_rates(sdr_params["rates"]),
                "sample_rate_values_full": sdr_params["rates"],
                "fft_size_values": fft_size_values,
                "fft_window_values": window_function_names,
                "has_soapy_agc": sdr_params["has_soapy_agc"],
                "antennas": sdr_params["antennas"],
                "frequency_ranges": sdr_params.get("frequency_ranges", {}),
                "clock_info": sdr_params.get("clock_info", {}),
                "temperature": sdr_params.get("temperature", {}),
                "capabilities": _strip_sample_rate_ranges(sdr_params.get("capabilities", {})),
            }

            # try:
            #     pretty_params = json.dumps(params, indent=2, sort_keys=True)
            #     print(
            #         f"[DEBUG] SoapySDR parameters for {sdr.get('name', sdr_id)}:\\n{pretty_params}"
            #     )
            # except Exception as e:
            #     print(
            #         f"[DEBUG] SoapySDR parameters (non-JSON) for {sdr.get('name', sdr_id)}: {params}"
            #     )
            #     print(f"[DEBUG] Pretty print failed: {e}")

            sdr_parameters_cache[cache_key] = params
            reply = {"success": True, "data": params}

        elif sdr.get("type") in ["uhd"]:
            logger.info("Getting SDR parameters from UHD/USRP for SDR: %s", sdr)

            probe_process = await asyncio.create_subprocess_exec(
                "python3",
                "-c",
                "from hardware.uhdprobe import probe_uhd_usrp; " f"print(probe_uhd_usrp({sdr}))",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await _communicate_probe(probe_process, timeout)

                if probe_process.returncode != 0:
                    error_output = stderr.decode().strip()
                    raise Exception(f"UHD probe process failed: {error_output}")

            except asyncio.TimeoutError:
                raise TimeoutError("Timed out while getting SDR parameters from UHD/USRP")

            sdr_params_reply = eval(stdout.decode().strip())

            if sdr_params_reply["success"] is False:
                logger.error(sdr_params_reply)
                raise Exception(sdr_params_reply["error"])

            sdr_params = sdr_params_reply["data"]

            logger.debug("Got SDR parameters from UHD/USRP: %s", sdr_params)

            window_function_names = list(window_functions.keys())
            fft_size_values = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

            params = {
                "gain_values": sdr_params["gains"],
                "sample_rate_values": [rate for rate in sdr_params["rates"] if rate >= 100000],
                "fft_size_values": fft_size_values,
                "fft_window_values": window_function_names,
                "has_uhd_agc": sdr_params.get("has_uhd_agc", False),
                "antennas": sdr_params["antennas"],
                "frequency_ranges": sdr_params.get("frequency_ranges", {}),
                "clock_info": sdr_params.get("clock_info", {}),
                "temperature": sdr_params.get("temperature", {}),
                "capabilities": _strip_sample_rate_ranges(sdr_params.get("capabilities", {})),
            }

            sdr_parameters_cache[cache_key] = params
            reply = {"success": True, "data": params}

        elif sdr.get("type") in ["sigmfplayback"]:
            logger.info("Getting parameters from SigMF recording for SDR: %s", sdr)

            recording_path = sdr.get("recording_path", "")

            if not recording_path:
                logger.warning("No recording_path available yet for sigmfplayback SDR")
                window_function_names = list(window_functions.keys())
                fft_size_values = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

                params = {
                    "gain_values": [0.0],
                    "sample_rate_values": [2048000],  # Default
                    "fft_size_values": fft_size_values,
                    "fft_window_values": window_function_names,
                    "has_agc": False,
                    "has_bias_t": False,
                    "has_tuner_agc": False,
                    "has_rtl_agc": False,
                    "has_soapy_agc": False,
                    "antennas": {"tx": [], "rx": ["RX"]},
                    "frequency_ranges": {"rx": {"min": 0, "max": 6000, "step": 0.1}},
                }

                reply = {"success": True, "data": params}
                return reply

            sdr["recording_path"] = recording_path

            probe_process = await asyncio.create_subprocess_exec(
                "python3",
                "-c",
                "from hardware.sigmfprobe import probe_sigmf_recording; "
                f"print(probe_sigmf_recording({sdr}))",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await _communicate_probe(probe_process, timeout)

                if probe_process.returncode != 0:
                    error_output = stderr.decode().strip()
                    raise Exception(f"SigMF probe process failed: {error_output}")

            except asyncio.TimeoutError:
                raise TimeoutError("Timed out while getting parameters from SigMF recording")

            sdr_params_reply = eval(stdout.decode().strip())

            if sdr_params_reply["success"] is False:
                logger.error(sdr_params_reply)
                raise Exception(sdr_params_reply["error"])

            sdr_params = sdr_params_reply["data"]

            logger.debug("Got parameters from SigMF recording: %s", sdr_params)

            window_function_names = list(window_functions.keys())
            fft_size_values = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

            params = {
                "gain_values": sdr_params["gains"],
                "sample_rate_values": sdr_params["rates"],
                "fft_size_values": fft_size_values,
                "fft_window_values": window_function_names,
                "has_agc": sdr_params.get("has_agc", False),
                "has_bias_t": False,
                "has_tuner_agc": False,
                "has_rtl_agc": False,
                "has_soapy_agc": False,
                "antennas": {"tx": [], "rx": ["RX"]},
                "frequency_ranges": sdr_params.get("frequency_ranges", {}),
                "metadata": sdr_params.get("metadata", {}),
                "total_samples": sdr_params.get("total_samples", 0),
                "duration": sdr_params.get("duration", 0),
            }

            sdr_parameters_cache[cache_key] = params
            reply = {"success": True, "data": params}

    except TimeoutError:
        error_msg = (
            f"Timeout occurred while getting parameters from SDR with id {sdr_id} "
            f"within {timeout} seconds timeout"
        )
        logger.error(error_msg)
        if cache_key in sdr_parameters_cache:
            logger.warning(
                "Returning cached SDR parameters for %s after timeout: %s", sdr_id, error_msg
            )
            reply["success"] = True
            reply["data"] = sdr_parameters_cache[cache_key]
            reply["error"] = error_msg
            return reply
        reply["success"] = False
        reply["error"] = error_msg

    except Exception as e:
        error_msg = str(e)
        logger.error("Error occurred while getting parameters from SDR with id %s", sdr_id)
        logger.error(error_msg)
        if cache_key in sdr_parameters_cache:
            logger.warning(
                "Returning cached SDR parameters for %s after error: %s", sdr_id, error_msg
            )
            reply["success"] = True
            reply["data"] = sdr_parameters_cache[cache_key]
            reply["error"] = error_msg
            return reply
        reply["success"] = False
        reply["error"] = error_msg

    return reply
