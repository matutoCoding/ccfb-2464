// GLSL ES 3.00 着色器集合

export const FULLSCREEN_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ---------- G-Buffer: 位置(RGBA8 打包 16bit xy) / 法线 / 反照率(含alpha) ----------
// 位置编码: 场景尺度内的世界坐标归一化到 [0,1], 每分量拆高低字节
// 兼容性说明: 部分软件渲染器 (SwiftShader) 的浮点颜色附件不可渲染, 故全部用 RGBA8
export const GBUF_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
uniform vec4 uClipPlane; // 世界空间平面 (xyz 法线, w 负的过点距离)
out vec3 vWorldPos;
out vec3 vNormal;
out float vClip;
void main(){
  vec4 wp = uModel * vec4(aPosition, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  vClip = dot(wp.xyz, uClipPlane.xyz) + uClipPlane.w;
  gl_Position = uViewProj * wp;
}`;

export const GBUF_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in float vClip;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uUseHeat;     // 0=普通着色 1=色谱
uniform sampler2D uHeatTex; // 一维色谱查找表
uniform float uHeatValue;
uniform vec3 uSceneMin;     // 场景包围盒最小点 (位置编码)
uniform vec3 uSceneInvSize; // 包围盒尺寸倒数
layout(location=0) out vec4 outPos;
layout(location=1) out vec4 outNormal;
layout(location=2) out vec4 outAlbedo;
// 把一个 [0,1] 浮点拆成两个 8 位通道
vec2 encode16(float f){
  f = clamp(f, 0.0, 1.0);
  float hi = floor(f * 255.0 + 0.5) / 255.0;
  float lo = (f - hi) * 255.0;
  return vec2(hi, lo / 255.0);
}
void main(){
  if (vClip < 0.0) discard;
  vec3 nrm = normalize(vNormal) * 0.5 + 0.5;
  outNormal = vec4(nrm, 1.0);
  // 位置: R/G 存 x 的高低字节, B/A 存 y; z 由深度纹理重建
  vec3 pn = (vWorldPos - uSceneMin) * uSceneInvSize;
  vec2 ex = encode16(pn.x);
  vec2 ey = encode16(pn.y);
  outPos = vec4(ex, ey);
  vec3 base = uColor;
  if (uUseHeat > 0.5) {
    base = texture(uHeatTex, vec2(clamp(uHeatValue, 0.0, 1.0), 0.5)).rgb;
  }
  outAlbedo = vec4(base, uAlpha);
}`;

// 支持逐顶点色谱值的 G-Buffer 片元着色器变体 (通过第二 attribute)
export const GBUF_VS_HEAT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aHeat;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
uniform vec4 uClipPlane;
out vec3 vWorldPos;
out vec3 vNormal;
out float vClip;
out float vHeat;
void main(){
  vec4 wp = uModel * vec4(aPosition, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  vClip = dot(wp.xyz, uClipPlane.xyz) + uClipPlane.w;
  vHeat = aHeat;
  gl_Position = uViewProj * wp;
}`;

export const GBUF_FS_HEAT = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in float vClip;
in float vHeat;
uniform sampler2D uHeatTex;
uniform float uAlpha;
uniform vec3 uSceneMin;
uniform vec3 uSceneInvSize;
layout(location=0) out vec4 outPos;
layout(location=1) out vec4 outNormal;
layout(location=2) out vec4 outAlbedo;
vec2 encode16(float f){
  f = clamp(f, 0.0, 1.0);
  float hi = floor(f * 255.0 + 0.5) / 255.0;
  float lo = (f - hi) * 255.0;
  return vec2(hi, lo / 255.0);
}
void main(){
  if (vClip < 0.0) discard;
  vec3 nrm = normalize(vNormal) * 0.5 + 0.5;
  outNormal = vec4(nrm, 1.0);
  vec3 pn = (vWorldPos - uSceneMin) * uSceneInvSize;
  outPos = vec4(encode16(pn.x), encode16(pn.y));
  vec3 base = texture(uHeatTex, vec2(clamp(vHeat, 0.0, 1.0), 0.5)).rgb;
  outAlbedo = vec4(base, uAlpha);
}`;

// ---------- SSAO (半分辨率): 从深度重建世界坐标 ----------
export const SSAO_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uNormalTex;
uniform sampler2D uDepthTex;
uniform sampler2D uNoiseTex;
uniform mat4 uInvViewProj;
uniform mat4 uProj;
uniform vec3 uSamples[32];
uniform float uRadius;
uniform float uStrength;
uniform vec2 uNoiseScale;
out float outOcclusion;
vec3 worldFromDepth(vec2 uv, float depth){
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}
void main(){
  vec4 nSample = texture(uNormalTex, vUv);
  vec3 n = nSample.xyz * 2.0 - 1.0;
  float depth = texture(uDepthTex, vUv).r;
  if (nSample.a < 0.01 || length(n) < 0.01) { outOcclusion = 1.0; return; }
  vec3 pos = worldFromDepth(vUv, depth);
  vec3 rand = texture(uNoiseTex, vUv * uNoiseScale).xyz * 2.0 - 1.0;
  vec3 tangent = normalize(rand - n * dot(rand, n));
  vec3 bitangent = cross(n, tangent);
  mat3 tbn = mat3(tangent, bitangent, n);
  float occlusion = 0.0;
  for (int i = 0; i < 32; i++) {
    vec3 samplePos = tbn * uSamples[i];
    samplePos = pos + samplePos * uRadius;
    vec4 offset = uProj * vec4(samplePos, 1.0);
    offset.xyz /= offset.w;
    vec2 suv = offset.xy * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    vec3 sceneN = texture(uNormalTex, suv).xyz * 2.0 - 1.0;
    if (length(sceneN) < 0.01) continue;
    float sceneDepth = texture(uDepthTex, suv).r;
    vec3 scenePos = worldFromDepth(suv, sceneDepth);
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(0.0001, length(pos - scenePos)));
    occlusion += ((scenePos.y + 0.0001 < samplePos.y) ? 1.0 : 0.0) * rangeCheck;
  }
  outOcclusion = clamp(1.0 - (occlusion / 32.0) * uStrength, 0.0, 1.0);
}`;

export const SSAO_BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSsao;
out float outVal;
void main(){
  vec2 texel = 1.0 / vec2(textureSize(uSsao, 0));
  float sum = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      sum += texture(uSsao, vUv + vec2(float(x), float(y)) * texel).r;
    }
  }
  outVal = sum / 25.0;
}`;

// ---------- 边缘描线 (Sobel, 基于法线+深度) ----------
export const EDGE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDepthTex;
uniform sampler2D uNormalTex;
uniform float uStrength;
out float outEdge;
vec3 nrm(vec2 uv){ return texture(uNormalTex, uv).xyz * 2.0 - 1.0; }
void main(){
  vec2 texel = 1.0 / vec2(textureSize(uNormalTex, 0));
  float nC = length(nrm(vUv));
  if (nC < 0.01) { outEdge = 0.0; return; }
  float e = 0.0;
  // Sobel 法线
  vec3 gx = nrm(vUv + vec2(texel.x, 0.0)) - nrm(vUv - vec2(texel.x, 0.0));
  vec3 gy = nrm(vUv + vec2(0.0, texel.y)) - nrm(vUv - vec2(0.0, texel.y));
  e += length(gx) + length(gy);
  // 深度差
  float d1 = texture(uDepthTex, vUv + texel).r;
  float d2 = texture(uDepthTex, vUv - texel).r;
  float d3 = texture(uDepthTex, vUv + vec2(texel.x, -texel.y)).r;
  float d4 = texture(uDepthTex, vUv + vec2(-texel.x, texel.y)).r;
  float dz = abs(d1 - d2) + abs(d3 - d4);
  e += dz * 60.0;
  outEdge = clamp(e * uStrength, 0.0, 1.0);
}`;

// ---------- 合成: 光照 + SSAO + 描边 ----------
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uNormalTex;
uniform sampler2D uAlbedoTex;
uniform sampler2D uSsaoTex;
uniform float uSsaoEnabled;
uniform float uEdge;
uniform vec3 uLightDir;
uniform vec3 uEyePos;
out vec4 outColor;
void main(){
  vec4 albedoA = texture(uAlbedoTex, vUv);
  if (albedoA.a < 0.01) discard;
  vec3 n = texture(uNormalTex, vUv).xyz * 2.0 - 1.0;
  vec3 albedo = albedoA.rgb;
  vec3 L = normalize(uLightDir);
  // 视线方向用屏幕导数近似 (无位置纹理时的廉价方案)
  vec3 V = normalize(vec3(0.0, 0.0, 1.0));
  vec3 H = normalize(L + V);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, H), 0.0), 48.0) * 0.35;
  float ambient = 0.38;
  float ao = mix(1.0, texture(uSsaoTex, vUv).r, uSsaoEnabled);
  vec3 color = albedo * ((ambient * ao) + diff * 0.85 * ao) + vec3(spec * ao);
  // 轮廓描线压暗
  color *= 1.0 - uEdge * 0.75;
  color = pow(color, vec3(1.0 / 2.2));
  outColor = vec4(color, albedoA.a);
}`;

// ---------- 平面 gizmo ----------
export const GIZMO_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform mat4 uViewProj;
uniform mat4 uModel;
void main(){ gl_Position = uViewProj * uModel * vec4(aPosition, 1.0); }`;

export const GIZMO_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){ outColor = uColor; }`;

// ---------- 剖面填充 (CPU 轮廓 -> 三角扇) ----------
export const CAP_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform mat4 uViewProj;
void main(){ gl_Position = uViewProj * vec4(aPosition, 1.0); }`;

export const CAP_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){ outColor = uColor; }`;

// ---------- 2D 标注 (NDC 线/点) ----------
export const ANNOT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos; // xy = NDC, z 忽略
uniform vec2 uViewport;
void main(){ gl_Position = vec4(aPos.xy, 0.999, 1.0); }`;

export const ANNOT_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){ outColor = uColor; }`;
