import { beamVertexFloats, spriteFloats, type LightBatch } from "./lightBatch";
import {
  beamFragment,
  beamVertex,
  compositeFragment,
  downFragment,
  fullscreenVertex,
  spriteFragment,
  spriteVertex,
  upFragment,
} from "./lightShaders";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

const bloomLevels = 5;

const compile = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Cannot create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compile failed");
  return shader;
};

const link = (
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): WebGLProgram => {
  const program = gl.createProgram();
  if (!program) throw new Error("Cannot create a program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "Program link failed");
  return program;
};

/**
 * Draws one frame of stage light on the GPU: beams and sprites added into an HDR buffer, a dual-filter bloom, and a
 * tone-mapped composite. Its transparent pixels leave the clip untouched without a full-screen CSS blend layer.
 */
export class LightRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly hdr: boolean;
  private readonly sprite: WebGLProgram;
  private readonly beam: WebGLProgram;
  private readonly down: WebGLProgram;
  private readonly up: WebGLProgram;
  private readonly composite: WebGLProgram;
  private readonly spriteVao: WebGLVertexArrayObject;
  private readonly beamVao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly beamBuffer: WebGLBuffer;
  private readonly buffers: WebGLBuffer[] = [];
  private scene: Target | undefined;
  private mips: Target[] = [];
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  /** Undefined when the device has no WebGL2: the stage then simply stays dark. */
  static create(canvas: HTMLCanvasElement | OffscreenCanvas): LightRenderer | undefined {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
    });
    if (!gl) return undefined;
    try {
      return new LightRenderer(gl);
    } catch {
      return undefined;
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.hdr = gl.getExtension("EXT_color_buffer_float") !== null;
    this.sprite = link(gl, spriteVertex, spriteFragment);
    this.beam = link(gl, beamVertex, beamFragment);
    this.down = link(gl, fullscreenVertex, downFragment);
    this.up = link(gl, fullscreenVertex, upFragment);
    this.composite = link(gl, fullscreenVertex, compositeFragment);
    this.emptyVao = this.vao();

    this.spriteVao = this.vao();
    const corners = this.buffer(
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.attribute(this.sprite, "a_corner", corners, 2, 2 * 4, 0, 0);
    this.instanceBuffer = this.buffer(null, gl.DYNAMIC_DRAW);
    const stride = spriteFloats * 4;
    this.attribute(
      this.sprite,
      "a_shape",
      this.instanceBuffer,
      4,
      stride,
      0,
      1,
    );
    this.attribute(
      this.sprite,
      "a_light",
      this.instanceBuffer,
      4,
      stride,
      16,
      1,
    );
    this.attribute(
      this.sprite,
      "a_param",
      this.instanceBuffer,
      2,
      stride,
      32,
      1,
    );

    this.beamVao = this.vao();
    this.beamBuffer = this.buffer(null, gl.DYNAMIC_DRAW);
    const beamStride = beamVertexFloats * 4;
    this.attribute(this.beam, "a_pos", this.beamBuffer, 2, beamStride, 0, 0);
    this.attribute(this.beam, "a_cone", this.beamBuffer, 2, beamStride, 8, 0);
    this.attribute(this.beam, "a_light", this.beamBuffer, 4, beamStride, 16, 0);
    gl.bindVertexArray(null);
  }

  private vao(): WebGLVertexArrayObject {
    const vao = this.gl.createVertexArray();
    if (!vao) throw new Error("Cannot create a vertex array");
    this.gl.bindVertexArray(vao);
    return vao;
  }

  private buffer(data: Float32Array | null, usage: number): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Cannot create a buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (data) gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.buffers.push(buffer);
    return buffer;
  }

  private attribute(
    program: WebGLProgram,
    name: string,
    buffer: WebGLBuffer,
    size: number,
    stride: number,
    offset: number,
    divisor: number,
  ): void {
    const gl = this.gl;
    const location = gl.getAttribLocation(program, name);
    if (location < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(location, divisor);
  }

  private uniform(
    program: WebGLProgram,
    name: string,
  ): WebGLUniformLocation | null {
    const key = `${this.programName(program)}:${name}`;
    if (!this.uniforms.has(key))
      this.uniforms.set(key, this.gl.getUniformLocation(program, name));
    return this.uniforms.get(key) ?? null;
  }

  private programName(program: WebGLProgram): string {
    const names: readonly (readonly [WebGLProgram, string])[] = [
      [this.sprite, "sprite"],
      [this.beam, "beam"],
      [this.down, "down"],
      [this.up, "up"],
    ];
    return names.find(([candidate]) => candidate === program)?.[1] ?? "composite";
  }

  private target(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer)
      throw new Error("Cannot create a render target");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (this.hdr)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        width,
        height,
        0,
        gl.RGBA,
        gl.HALF_FLOAT,
        null,
      );
    else
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    return { framebuffer, texture, width, height };
  }

  private release(target: Target | undefined): void {
    if (!target) return;
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  /** Render targets follow the drawing-buffer size; the bloom chain halves down from the scene. */
  private ensureTargets(width: number, height: number): void {
    if (this.scene?.width === width && this.scene.height === height) return;
    this.release(this.scene);
    for (const mip of this.mips) this.release(mip);
    this.scene = this.target(width, height);
    this.mips = [];
    let w = width;
    let h = height;
    for (let i = 0; i < bloomLevels; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.mips.push(this.target(w, h));
    }
  }

  render(
    batch: LightBatch,
    time: number,
    view: { width: number; height: number },
    protect: { lyrics?: Rect; roll?: Rect },
    bloom: number,
  ): void {
    const gl = this.gl;
    const canvas = gl.canvas;
    this.ensureTargets(canvas.width, canvas.height);
    const scene = this.scene;
    if (!scene) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    if (batch.beamCount > 0) {
      gl.useProgram(this.beam);
      gl.uniform2f(this.uniform(this.beam, "u_view"), view.width, view.height);
      gl.uniform1f(this.uniform(this.beam, "u_time"), time);
      gl.bindVertexArray(this.beamVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.beamBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        batch.beams.subarray(0, batch.beamCount * 3 * beamVertexFloats),
        gl.DYNAMIC_DRAW,
      );
      gl.drawArrays(gl.TRIANGLES, 0, batch.beamCount * 3);
    }
    if (batch.spriteCount > 0) {
      gl.useProgram(this.sprite);
      gl.uniform2f(
        this.uniform(this.sprite, "u_view"),
        view.width,
        view.height,
      );
      gl.bindVertexArray(this.spriteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        batch.sprites.subarray(0, batch.spriteCount * spriteFloats),
        gl.DYNAMIC_DRAW,
      );
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.spriteCount);
    }

    gl.bindVertexArray(this.emptyVao);
    this.bloomChain(scene);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.composite);
    this.bindTexture(0, scene.texture, this.uniform(this.composite, "u_scene"));
    this.bindTexture(
      1,
      this.mips[0]?.texture ?? scene.texture,
      this.uniform(this.composite, "u_bloom"),
    );
    gl.uniform1f(this.uniform(this.composite, "u_bloomStrength"), bloom);
    gl.uniform2f(
      this.uniform(this.composite, "u_view"),
      view.width,
      view.height,
    );
    const rect = (r: Rect | undefined) =>
      (r ? [r.left, r.top, r.width, r.height] : [0, 0, 0, 0]) as [
        number,
        number,
        number,
        number,
      ];
    gl.uniform4f(
      this.uniform(this.composite, "u_lyrics"),
      ...rect(protect.lyrics),
    );
    gl.uniform4f(this.uniform(this.composite, "u_roll"), ...rect(protect.roll));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTexture(
    unit: number,
    texture: WebGLTexture,
    location: WebGLUniformLocation | null,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  private bloomChain(scene: Target): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.useProgram(this.down);
    let source = scene;
    for (const [index, mip] of this.mips.entries()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, mip.framebuffer);
      gl.viewport(0, 0, mip.width, mip.height);
      this.bindTexture(0, source.texture, this.uniform(this.down, "u_source"));
      gl.uniform2f(
        this.uniform(this.down, "u_texel"),
        1 / source.width,
        1 / source.height,
      );
      gl.uniform1f(
        this.uniform(this.down, "u_threshold"),
        index === 0 ? 0.08 : 0,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = mip;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.up);
    for (let i = this.mips.length - 1; i > 0; i--) {
      const from = this.mips[i];
      const to = this.mips[i - 1];
      if (!from || !to) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
      gl.viewport(0, 0, to.width, to.height);
      this.bindTexture(0, from.texture, this.uniform(this.up, "u_source"));
      gl.uniform2f(
        this.uniform(this.up, "u_texel"),
        0.5 / from.width,
        0.5 / from.height,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  dispose(): void {
    const gl = this.gl;
    this.release(this.scene);
    for (const mip of this.mips) this.release(mip);
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    for (const vao of [this.spriteVao, this.beamVao, this.emptyVao]) gl.deleteVertexArray(vao);
    for (const program of [this.sprite, this.beam, this.down, this.up, this.composite]) {
      gl.deleteProgram(program);
    }
    // The context itself stays: a canvas keeps one context for life, and a remount (React StrictMode, hot reload)
    // takes the same one up again.
  }
}
