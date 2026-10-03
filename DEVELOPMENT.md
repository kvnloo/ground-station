# Development

This guide covers development setup, build steps, and tooling.

## Prerequisites

*   Python 3.8+
*   Node.js 14+
*   Docker (optional)

## Installation

### Option 1: Using pyproject.toml (Recommended)

The backend now uses modern Python packaging with `pyproject.toml`, which provides better dependency management and development tooling.

1.  **Backend Setup**
    ```bash
    cd backend
    python -m venv venv
    source venv/bin/activate  # On Windows: venv\Scripts\activate

    # Install the project in editable mode with all dependencies
    pip install -e .

    # For development (includes testing and code quality tools)
    pip install -e ".[dev]"

    # Start the server
    python app.py --host 0.0.0.0 --port 5000
    ```

2.  **Frontend Setup**
    ```bash
    cd frontend
    npm install
    npm run dev
    ```
    The development server proxies API and socket traffic to the backend port defined in `.env.development` (defaults to `localhost:5000`).

### Option 2: Using requirements.txt (Traditional)

1.  **Backend**
    ```bash
    cd backend
    python -m venv venv
    source venv/bin/activate  # On Windows: venv\Scripts\activate
    pip install -r requirements.txt

    # For development
    pip install -r requirements-dev.txt

    python app.py --host 0.0.0.0 --port 5000
    ```

2.  **Frontend**
    ```bash
    cd frontend
    npm install
    npm run dev
    ```

## GNU Radio decoder support

APRS, FSK/GFSK/GMSK, BPSK, and LoRa decoders require GNU Radio and its
out-of-tree `gr-satellites` and `gr-lora_sdr` modules. The supported releases
are GNU Radio **3.10.12.0** and VOLK **3.2.0**. Build them in a user-owned,
versioned prefix so they can coexist with a distribution-provided GNU Radio.
Do not install either build into the backend virtual environment or overwrite
the OS installation.

The backend launcher uses `/opt/ground-station/gnuradio-3.10.12.0` by default
for maintainers who have that local installation. Other developers should pass
their own prefix through `GNU_RADIO_PREFIX` and `GNU_RADIO_VOLK_PREFIX`.

### Prerequisites

On Debian or Ubuntu, install the native build prerequisites. Package names can
vary on other distributions.

```bash
sudo apt-get install build-essential cmake git libboost-all-dev libgmp-dev \
    libmpfr-dev liblog4cpp5-dev libspdlog-dev libfmt-dev libzmq3-dev \
    pybind11-dev python3-pybind11 python3-packaging
```

Create the project's backend virtual environment before compiling, then install
the Python build helpers into that environment:

```bash
cd /path/to/ground-station/backend
./venv/bin/python -m pip install packaging pybind11
```

### Build an isolated GNU Radio prefix

The following creates a private installation under `~/.local/opt`; it does not
write to `/usr`, change `ldconfig`, or affect the OS GNU Radio packages. Set
the variables once in the shell that performs the build:

```bash
export GS_GNURADIO_VERSION=3.10.12.0
export GS_VOLK_VERSION=3.2.0
export GS_DEPS_PREFIX="$HOME/.local/opt/ground-station"
export GNU_RADIO_PREFIX="$GS_DEPS_PREFIX/gnuradio-$GS_GNURADIO_VERSION"
export GNU_RADIO_VOLK_PREFIX="$GS_DEPS_PREFIX/volk-$GS_VOLK_VERSION"
export GS_BUILD_ROOT="$HOME/src/ground-station-radio-builds"
export GS_REPO_ROOT=/path/to/ground-station
export GS_BACKEND_PYTHON="$GS_REPO_ROOT/backend/venv/bin/python"
mkdir -p "$GS_BUILD_ROOT"
```

Build the matching VOLK release first:

```bash
cd "$GS_BUILD_ROOT"
git clone --branch "v$GS_VOLK_VERSION" --depth 1 --recurse-submodules \
    https://github.com/gnuradio/volk.git "volk-$GS_VOLK_VERSION"
cmake -S "volk-$GS_VOLK_VERSION" -B "volk-$GS_VOLK_VERSION/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$GNU_RADIO_VOLK_PREFIX"
cmake --build "volk-$GS_VOLK_VERSION/build" --parallel
cmake --install "volk-$GS_VOLK_VERSION/build"
```

Build the pinned GNU Radio release against that private VOLK installation:

```bash
cd "$GS_BUILD_ROOT"
git clone --branch "v$GS_GNURADIO_VERSION" --depth 1 --recurse-submodules \
    https://github.com/gnuradio/gnuradio.git "gnuradio-$GS_GNURADIO_VERSION"
cmake -S "gnuradio-$GS_GNURADIO_VERSION" -B "gnuradio-$GS_GNURADIO_VERSION/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$GNU_RADIO_PREFIX" \
    -DCMAKE_PREFIX_PATH="$GNU_RADIO_VOLK_PREFIX" \
    -DENABLE_PYTHON=ON \
    -DENABLE_GR_QTGUI=OFF \
    -DENABLE_GR_ZEROMQ=ON \
    -DENABLE_TESTING=OFF \
    -DPython3_EXECUTABLE="$GS_BACKEND_PYTHON" \
    -DPYTHON_EXECUTABLE="$GS_BACKEND_PYTHON"
cmake --build "gnuradio-$GS_GNURADIO_VERSION/build" --parallel
cmake --install "gnuradio-$GS_GNURADIO_VERSION/build"
```

### Build the required out-of-tree modules

Install both modules into the same GNU Radio prefix. `CMAKE_PREFIX_PATH` makes
their build resolve the private GNU Radio instead of a system installation.

```bash
cd "$GS_BUILD_ROOT"
git clone --depth 1 https://github.com/daniestevez/gr-satellites.git
cmake -S gr-satellites -B gr-satellites/build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$GNU_RADIO_PREFIX" \
    -DCMAKE_PREFIX_PATH="$GNU_RADIO_PREFIX;$GNU_RADIO_VOLK_PREFIX" \
    -DPYTHON_EXECUTABLE="$GS_BACKEND_PYTHON" \
    -DGR_PYTHON_DIR="$GNU_RADIO_PREFIX/lib/python3.12/site-packages"
cmake --build gr-satellites/build --parallel
cmake --install gr-satellites/build

git clone --depth 1 https://github.com/tapparelj/gr-lora_sdr.git
cmake -S gr-lora_sdr -B gr-lora_sdr/build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$GNU_RADIO_PREFIX" \
    -DCMAKE_PREFIX_PATH="$GNU_RADIO_PREFIX;$GNU_RADIO_VOLK_PREFIX" \
    -DPYTHON_EXECUTABLE="$GS_BACKEND_PYTHON" \
    -DGR_PYTHON_DIR="$GNU_RADIO_PREFIX/lib/python3.12/site-packages"
cmake --build gr-lora_sdr/build --parallel
cmake --install gr-lora_sdr/build
```

### Verify and run the backend

The launcher preserves normal backend venv dependencies and puts the selected
GNU Radio and VOLK libraries ahead of inherited `LD_LIBRARY_PATH`. This avoids
loading Python bindings from one GNU Radio build and core libraries from
another build with the same SONAME. Do not add `venv/lib` manually to
`LD_LIBRARY_PATH`.

```bash
cd "$GS_REPO_ROOT"
GNU_RADIO_PREFIX="$GNU_RADIO_PREFIX" \
GNU_RADIO_VOLK_PREFIX="$GNU_RADIO_VOLK_PREFIX" \
    ./backend/startdev.sh --check-gnuradio

GNU_RADIO_PREFIX="$GNU_RADIO_PREFIX" \
GNU_RADIO_VOLK_PREFIX="$GNU_RADIO_VOLK_PREFIX" \
    ./backend/startdev.sh --log-level=INFO --host=0.0.0.0 --port=5000
```

`--check-gnuradio` imports GNU Radio, APRS/GFSK/BPSK decoder modules, and
checks that those decoders are registered. It also verifies that the mapped GNU
Radio core shared libraries come from the selected prefix.

> **Note:** Docker images build their own GNU Radio stack. These instructions
> apply only to native development environments.

## SSDV Decoder Support

The SSDV decoder uses the upstream reference codec to reconstruct packetised
JPEG images. Docker builds it automatically. For a native development setup,
build the same pinned utility and point the backend at it:

```bash
sudo apt-get install build-essential git
git clone https://github.com/fsphil/ssdv.git /tmp/ground-station-ssdv
cd /tmp/ground-station-ssdv
git checkout d1ceda81b69f88741396f3e052b50c8ae40efb76
make -j"$(nproc)"

export GS_SSDV_BIN="$PWD/ssdv"
```

The first receiver profile is 9600-baud BPSK for standard 256-byte SSDV
packets, including OBJECT AY. Other satellite-specific SSDV transports require
their own verified PHY/framing profile.

## Development Workflow with pyproject.toml

The project's `pyproject.toml` provides comprehensive tooling configuration:

### Code Formatting
```bash
# Format code with Black (line length: 100)
black .

# Sort imports with isort
isort .
```

### Testing

**Backend Tests (Python)**
```bash
cd backend

# Run tests with coverage
pytest

# Run specific test markers
pytest -m unit          # Run only unit tests
pytest -m integration   # Run only integration tests
pytest -m slow          # Run slow tests

# Generate coverage reports
pytest --cov=crud --cov=server --cov=controllers --cov-report=html
```

**Frontend Tests (JavaScript/React)**
```bash
cd frontend

# Run unit/component tests
npm test

# Run with coverage
npm run test:coverage

# Run E2E tests (requires dev server running)
npm run test:e2e

# Run E2E tests with interactive UI
npm run test:e2e:ui
```

See [frontend/TESTING.md](frontend/TESTING.md) for comprehensive testing documentation.

### Pre-commit Hooks (Recommended)
```bash
# Install pre-commit hooks to automatically check code before commits
pre-commit install

# Run hooks manually on all files
pre-commit run --all-files
```

## Package Information

The project is configured as a Python package with the following metadata:
- **Name:** ground-station
- **Version:** 0.1.0
- **Python Support:** 3.8, 3.9, 3.10, 3.11, 3.12
- **License:** GPL-3.0-only
- **Entry Point:** `ground-station` command (after installation)

You can install the package and use it as a command-line tool:
```bash
pip install -e .
ground-station  # Starts the application
```
