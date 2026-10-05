/** WebGL2 ring-buffer waterfall. The Canvas worker remains the compatibility renderer. */
const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = vec2(position.x * .5 + .5, .5 - position.y * .5); gl_Position = vec4(position, 0., 1.); }`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D levels;
uniform sampler2D markers;
uniform sampler2D palette;
uniform float head;
uniform float rows;
void main() {
  float row = mod(head + floor(uv.y * rows), rows);
  float y = (row + .5) / rows;
  float level = texture(levels, vec2(uv.x, y)).r;
  vec3 base = texture(palette, vec2(level, .5)).rgb;
  float marker = texture(markers, vec2(uv.x, y)).r;
  color = vec4(mix(base, vec3(1.), marker * .5), 1.);
}`;

function shader(gl, type, source) {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(value);
        gl.deleteShader(value);
        throw new Error(message || 'WebGL shader compilation failed');
    }
    return value;
}

function cssColor(value) {
    const hex = /^#([0-9a-f]{6})$/i.exec(value || '');
    if (!hex) return [0.07, 0.07, 0.07];
    const number = Number.parseInt(hex[1], 16);
    return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}

export function createWebGlWaterfallRenderer(canvas, { width, height, palette, backgroundColor, onContextLost }) {
    let gl;
    try {
        gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
    } catch {
        return null;
    }
    if (!gl) return null;

    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        onContextLost?.();
    });

    try {
        const program = gl.createProgram();
        const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
        const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL program link failed');

        const vao = gl.createVertexArray();
        const buffer = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

        const makeTexture = () => {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return texture;
        };
        const levels = makeTexture();
        const markers = makeTexture();
        const paletteTexture = makeTexture();
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const uniforms = {
            head: gl.getUniformLocation(program, 'head'), rows: gl.getUniformLocation(program, 'rows'),
        };
        let row = 0;
        let rowData = new Uint8Array(0);
        let markerData = new Uint8Array(0);
        let currentWidth = 0;
        let currentHeight = 0;
        let currentPalette = palette;
        let currentBackground = backgroundColor;

        const uploadPalette = () => {
            gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, currentPalette);
        };
        const resize = (nextWidth, nextHeight) => {
            currentWidth = Math.max(1, nextWidth | 0);
            currentHeight = Math.max(1, nextHeight | 0);
            canvas.width = currentWidth;
            canvas.height = currentHeight;
            row = 0;
            rowData = new Uint8Array(currentWidth);
            markerData = new Uint8Array(currentWidth);
            for (const texture of [levels, markers]) {
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, currentWidth, currentHeight, 0, gl.RED, gl.UNSIGNED_BYTE, null);
            }
            uploadPalette();
        };
        const setPalette = (nextPalette, nextBackground) => {
            currentPalette = nextPalette;
            currentBackground = nextBackground;
            uploadPalette();
        };
        const pushFrame = (fft, min, max) => {
            if (!fft?.length || !currentWidth) return;
            const range = Math.max(max - min, 1e-6);
            for (let x = 0; x < currentWidth; x++) {
                // Match the Canvas renderer's sampling when bins outnumber
                // pixels, and its whole-bin stretch when they do not.
                const index = fft.length >= currentWidth
                    ? Math.min(Math.floor(x * fft.length / currentWidth), fft.length - 1)
                    : Math.min(Math.ceil((x + 1) * fft.length / currentWidth) - 1, fft.length - 1);
                rowData[x] = Math.max(0, Math.min(255, ((fft[index] - min) * 255 / range) | 0));
            }
            row = (row - 1 + currentHeight) % currentHeight;
            gl.bindTexture(gl.TEXTURE_2D, levels);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, currentWidth, 1, gl.RED, gl.UNSIGNED_BYTE, rowData);
            markerData.fill(0);
            gl.bindTexture(gl.TEXTURE_2D, markers);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, currentWidth, 1, gl.RED, gl.UNSIGNED_BYTE, markerData);
        };
        const markLatestRow = () => {
            for (let x = 0; x < currentWidth; x++) markerData[x] = x % 16 < 4 ? 255 : 0;
            gl.bindTexture(gl.TEXTURE_2D, markers);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, currentWidth, 1, gl.RED, gl.UNSIGNED_BYTE, markerData);
        };
        const present = () => {
            const [r, g, b] = cssColor(currentBackground);
            gl.viewport(0, 0, currentWidth, currentHeight);
            gl.clearColor(r, g, b, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            for (const [unit, texture, name] of [[0, levels, 'levels'], [1, markers, 'markers'], [2, paletteTexture, 'palette']]) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.uniform1i(gl.getUniformLocation(program, name), unit);
            }
            gl.uniform1f(uniforms.head, row);
            gl.uniform1f(uniforms.rows, currentHeight);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        };
        resize(width, height);
        return { resize, setPalette, pushFrame, markLatestRow, present, destroy: () => { gl.deleteProgram(program); } };
    } catch (error) {
        console.warn('WebGL waterfall initialization failed:', error);
        return null;
    }
}
