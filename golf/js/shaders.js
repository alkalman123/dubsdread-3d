/* GLSL ES 3.00 sources. */
(function (root) {
  'use strict';

  /* ============================================================ chunks */

  const NOISE = `
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3=fract(p3*0.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }

float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),
             mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y);
}
float vnoise3(vec3 p){
  vec3 i=floor(p), f=fract(p);
  vec3 u=f*f*(3.0-2.0*f);
  float n000=hash13(i), n100=hash13(i+vec3(1,0,0));
  float n010=hash13(i+vec3(0,1,0)), n110=hash13(i+vec3(1,1,0));
  float n001=hash13(i+vec3(0,0,1)), n101=hash13(i+vec3(1,0,1));
  float n011=hash13(i+vec3(0,1,1)), n111=hash13(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y),
             mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y),u.z);
}
float fbm2(vec2 p, int oct){
  float a=0.5, s=0.0, n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*vnoise(p); n+=a; p*=2.03; a*=0.5; }
  return s/n;
}
float ridged(vec2 p, int oct){
  float a=0.5,s=0.0,n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct)break; s+=a*(1.0-abs(vnoise(p)*2.0-1.0)); n+=a; p*=2.11; a*=0.5; }
  return s/n;
}`;

  const SKY = `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uGroundTint;
uniform float uTurbidity;
uniform float uHaze;

vec3 skyRadiance(vec3 dir){
  float up = dir.y;
  // steep falloff: the zenith stays deep blue and only the last few degrees
  // above the horizon go pale, which is what a clear sky actually does
  float t  = pow(clamp(1.0 - abs(up), 0.0, 1.0), 3.2);
  vec3 col = mix(uSkyZenith, uSkyHorizon, t);

  // thin haze band hugging the horizon
  float band = exp(-abs(up) * 16.0);
  col = mix(col, uSkyHorizon * 1.04, band * uHaze * 0.55);

  float mu = clamp(dot(normalize(dir), uSunDir), -1.0, 1.0);

  // Mie forward scattering halo
  float g = 0.74;
  float mie = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*mu, 1.5);
  col += uSunColor * mie * 0.0125 * uTurbidity;

  // broad glow
  col += uSunColor * pow(max(mu, 0.0), 9.0) * 0.075;

  // below the horizon: ground haze
  if (up < 0.0) col = mix(col, uGroundTint, clamp(-up * 4.5, 0.0, 0.90));
  return col;
}

vec3 sunDisc(vec3 dir){
  float mu = dot(normalize(dir), uSunDir);
  float d  = 0.99965;
  float s  = smoothstep(d, d + 0.00022, mu);
  float bloomRing = pow(max(mu,0.0), 2200.0) * 0.55;
  return uSunColor * (s * 42.0 + bloomRing * 8.0);
}`;

  const CLOUDS = `
uniform float uCloudCover;
uniform float uTime;
float cloudField(vec2 p){
  p += uTime * 0.0016;
  float base = fbm2(p * 1.05, 4);
  float det  = fbm2(p * 3.7 + base * 0.6, 3);
  float c = base * 0.72 + det * 0.28;
  return c;
}
vec4 clouds(vec3 dir){
  if (dir.y < 0.012) return vec4(0.0);
  vec2 uv = dir.xz / max(dir.y, 0.012) * 0.055;
  float c = cloudField(uv);
  float cover = uCloudCover;
  float a = smoothstep(0.60 - cover*0.42, 0.86 - cover*0.30, c);
  a *= smoothstep(0.012, 0.13, dir.y);
  // rough shading: lit tops, shaded bases
  float lit = smoothstep(0.55, 0.95, c);
  float hgt = clamp(dot(normalize(dir), uSunDir)*0.5+0.5, 0.0, 1.0);
  vec3 bright = uSunColor * (0.95 + 0.5*hgt);
  vec3 shade  = mix(uSkyHorizon*0.80, uSkyZenith*0.95, 0.4);
  vec3 col = mix(shade, bright, lit*0.85 + 0.15);
  col += uSunColor * pow(max(dot(normalize(dir),uSunDir),0.0), 12.0) * a * 0.35;
  return vec4(col, a * 0.94);
}`;

  const SHADOW = `
uniform sampler2D uShadow0;
uniform sampler2D uShadow1;
uniform mat4 uShadowVP0;
uniform mat4 uShadowVP1;
uniform vec2 uShadowTexel;
uniform float uCascadeSplit;

float pcf(sampler2D smap, vec3 pc, float bias, float radius){
  if (pc.x < 0.003 || pc.x > 0.997 || pc.y < 0.003 || pc.y > 0.997) return 1.0;
  // rotate the kernel per pixel: 9 taps then read like a much wider filter
  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  float ca = cos(a), sa = sin(a);
  float s = 0.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 k = vec2(float(x), float(y));
      vec2 r = vec2(k.x * ca - k.y * sa, k.x * sa + k.y * ca);
      float d = texture(smap, pc.xy + r * uShadowTexel * radius).r;
      s += (pc.z - bias) > d ? 0.0 : 1.0;
    }
  }
  return s / 9.0;
}

float shadowFactor(vec3 world, float ndl, float viewDist){
  float bias0 = mix(0.00035, 0.0022, 1.0 - ndl);
  if (viewDist < uCascadeSplit){
    vec4 p = uShadowVP0 * vec4(world, 1.0);
    vec3 pc = p.xyz / p.w * 0.5 + 0.5;
    float s0 = pcf(uShadow0, pc, bias0, 1.9);
    float fade = smoothstep(uCascadeSplit * 0.82, uCascadeSplit, viewDist);
    if (fade > 0.0){
      vec4 q = uShadowVP1 * vec4(world, 1.0);
      vec3 qc = q.xyz / q.w * 0.5 + 0.5;
      float s1 = pcf(uShadow1, qc, bias0 * 3.2, 1.0);
      return mix(s0, s1, fade);
    }
    return s0;
  }
  vec4 q = uShadowVP1 * vec4(world, 1.0);
  vec3 qc = q.xyz / q.w * 0.5 + 0.5;
  return pcf(uShadow1, qc, bias0 * 3.2, 1.0);
}`;

  const FOG = `
uniform float uFogDensity;
uniform vec3  uCamPos;
vec3 applyFog(vec3 col, vec3 world, vec3 viewDir){
  float d = distance(world, uCamPos);
  // aerial perspective thins out with altitude
  float hAvg = max((world.y + uCamPos.y) * 0.5, 0.0);
  float f = 1.0 - exp(-d * uFogDensity * exp(-hAvg * 0.0075));
  vec3 dirH = normalize(vec3(viewDir.x, clamp(viewDir.y, -0.22, 1.0), viewDir.z));
  vec3 fogCol = skyRadiance(dirH) * 0.88;
  float sun = pow(max(dot(normalize(viewDir), uSunDir), 0.0), 8.0);
  fogCol = mix(fogCol, uSunColor * 1.05, sun * 0.30);
  return mix(col, fogCol, clamp(f, 0.0, 0.90));
}`;

  const TONEMAP = `
vec3 aces(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}`;

  /* ============================================================ sky */

  const skyVert = `
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 1.0, 1.0); }`;

  const skyFrag = `
precision highp float;
in vec2 vNdc;
out vec4 frag;
uniform mat4 uInvViewProj;
uniform float uExposure;
${NOISE}
${SKY}
${CLOUDS}
void main(){
  vec4 p0 = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 p1 = uInvViewProj * vec4(vNdc,  1.0, 1.0);
  vec3 dir = normalize(p1.xyz / p1.w - p0.xyz / p0.w);
  vec3 col = skyRadiance(dir);
  vec4 cl = clouds(dir);
  col = mix(col, cl.rgb, cl.a);
  col += sunDisc(dir) * (1.0 - cl.a * 0.85);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================ terrain */

  const terrainVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aAO;
out vec3 vWorld;
out vec3 vNormal;
out float vAO;
uniform mat4 uViewProj;
void main(){
  vWorld = aPos;
  vNormal = aNormal;
  vAO = aAO;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

  const terrainFrag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vAO;
out vec4 frag;

uniform sampler2D uFieldA;    // fairway, green, sand, water  (signed distance, m)
uniform sampler2D uFieldB;    // tee, path, corridor, wood
uniform vec4  uFieldRect;     // x0, z0, size, 1/size
uniform vec2  uMowDir;        // dominant mowing direction for this hole
uniform float uExposure;
uniform float uDetail;        // 1 = near field, 0 = distant context

${NOISE}
${SKY}
${SHADOW}
${FOG}

vec4 fieldA(vec2 xz){ return texture(uFieldA, (xz - uFieldRect.xy) * uFieldRect.w); }
vec4 fieldB(vec2 xz){ return texture(uFieldB, (xz - uFieldRect.xy) * uFieldRect.w); }

// mowing stripe: returns -1..1 across the mower's path
float stripe(vec2 xz, vec2 dir, float period){
  float t = dot(xz, vec2(-dir.y, dir.x));
  return sin(t * 6.2831853 / period);
}

void main(){
  vec2 xz = vWorld.xz;
  vec4 A = fieldA(xz);
  vec4 B = fieldB(xz);
  float dFw = A.x, dGr = A.y, dSa = A.z, dWa = A.w;
  float dTe = B.x, dPa = B.y, dCo = B.z, wood = B.w;

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);
  float near = (1.0 - smoothstep(30.0, 240.0, viewDist)) * uDetail;   // detail fade

  // Metres of ground covered by one pixel. Any procedural detail finer than
  // this has to be faded out or it turns into aliasing noise, which is exactly
  // what a mip chain would do for a real texture.
  float px = max(max(abs(dFdx(xz.x)), abs(dFdy(xz.x))),
                 max(abs(dFdx(xz.y)), abs(dFdy(xz.y)))) + 1e-5;
  #define LOD(wave) (1.0 - smoothstep((wave) * 0.35, (wave) * 1.30, px))
  float lodMicro = LOD(0.31);
  float lodFine  = LOD(1.55);
  float lodBump  = LOD(0.72);

  /* ---- surface weights ------------------------------------------------ */
  float wGreen  = 1.0 - smoothstep(-0.35, 0.10, dGr);
  float wFringe = (1.0 - wGreen) * (1.0 - smoothstep(0.55, 1.60, dGr));
  float wSand   = 1.0 - smoothstep(-0.25, 0.30, dSa);
  float wTee    = (1.0 - smoothstep(-0.25, 0.25, dTe)) * (1.0 - wGreen);
  float wPath   = 1.0 - smoothstep(-0.15, 0.30, dPa);
  float wFw     = 1.0 - smoothstep(-0.35, 0.35, dFw);
  // the "first cut": a mown collar a couple of metres outside the fairway
  float wCut    = (1.0 - wFw) * (1.0 - smoothstep(0.3, 3.6, dFw));
  float wRough  = 1.0 - smoothstep(-0.5, 6.0, dCo);

  /* ---- turf colour ---------------------------------------------------- */
  // large scale health/patchiness
  float turfA  = fbm2(xz * 0.020, 3);
  float turfB = fbm2(xz * 0.085 + 31.7, 3);
  float fine  = lodFine  > 0.004 ? fbm2(xz * 0.65, 2) : 0.5;
  float micro = lodMicro > 0.004 ? vnoise(xz * 3.2)   : 0.5;

  vec3 cGreen  = mix(vec3(0.196,0.330,0.124), vec3(0.262,0.412,0.158), turfB);
  vec3 cFairway= mix(vec3(0.176,0.296,0.096), vec3(0.252,0.384,0.132), turfA);
  vec3 cRough  = mix(vec3(0.094,0.166,0.056), vec3(0.146,0.226,0.078), turfA);
  vec3 cNative = mix(vec3(0.124,0.184,0.078), vec3(0.196,0.252,0.110), turfB);
  vec3 cTee    = mix(vec3(0.150,0.266,0.090), vec3(0.212,0.340,0.124), turfB);
  vec3 cSand   = mix(vec3(0.520,0.452,0.318), vec3(0.660,0.594,0.442), turfB*0.7+fine*0.3);
  vec3 cPath   = mix(vec3(0.400,0.392,0.372), vec3(0.500,0.492,0.472), fine);

  // native fescue gets a wispier, drier read further from play
  cNative = mix(cNative, vec3(0.230,0.226,0.116), smoothstep(10.0, 48.0, dCo) * 0.62);

  vec3 albedo = cNative;
  albedo = mix(albedo, cRough,   wRough);
  albedo = mix(albedo, mix(cRough, cFairway, 0.45), wCut);
  albedo = mix(albedo, cFairway, wFw);
  albedo = mix(albedo, cTee,     wTee);
  albedo = mix(albedo, mix(cGreen, cFairway, 0.35), wFringe);
  albedo = mix(albedo, cGreen,   wGreen);
  albedo = mix(albedo, cPath,    wPath);
  albedo = mix(albedo, cSand,    wSand);

  /* ---- mowing patterns ------------------------------------------------ */
  float stripeAmt = 0.0;
  vec2  grainDir = uMowDir;

  float sFw = stripe(xz, uMowDir, 7.2);
  float sGr = stripe(xz, normalize(uMowDir + vec2(uMowDir.y, -uMowDir.x)), 2.05);
  float sRo = stripe(xz, uMowDir, 13.0);

  // soften the stripe edges so they read as bands of leaning grass
  sFw = sign(sFw) * pow(abs(sFw), 0.55);
  sGr = sign(sGr) * pow(abs(sGr), 0.55);
  sRo = sign(sRo) * pow(abs(sRo), 0.55);

  float mow = 0.0;
  mow += sFw * (wFw + wCut * 0.5) * 0.9;
  mow += sGr * wGreen * 1.0;
  mow += sRo * wRough * 0.42;
  mow += sFw * wTee * 0.9;
  stripeAmt = clamp(mow, -1.0, 1.0);

  // stripes are a lighting effect (blades leaning toward / away from you)
  float leanSign = stripeAmt;
  float stripeMask = clamp(wFw + wCut * 0.5 + wGreen + wRough * 0.55 + wTee, 0.0, 1.0)
                   * (1.0 - wSand) * (1.0 - wPath);
  albedo *= 1.0 + stripeAmt * stripeMask * (0.105 + wGreen * 0.055);

  // collar: a light fringe right at the edge and a slightly darker walk-off
  float collar = (1.0 - wGreen) * (1.0 - smoothstep(1.2, 5.5, dGr));
  albedo *= 1.0 - collar * 0.06;

  // fine grain + divot-scale variation
  float smoothTurf = 1.0 - wGreen * 0.82;
  albedo *= 1.0 + ((fine - 0.5) * 0.20 * lodFine * (1.0 - wSand)
                 + (micro - 0.5) * 0.15 * lodMicro) * smoothTurf;
  // a slower, coarser mottle that survives all the way to the horizon
  albedo *= 1.0 + (fbm2(xz * 0.30, 3) - 0.5) * 0.15 * smoothTurf;
  if (lodFine > 0.004) albedo *= 1.0 + (fbm2(xz * 0.55, 2) - 0.5) * 0.10 * smoothTurf * lodFine;
  // mower wheel tracks and wear along the corridor edges
  albedo *= 1.0 - (1.0 - smoothstep(0.0, 1.4, abs(dFw))) * 0.07;
  // sand ripples
  if (wSand * lodFine > 0.002) {
    float ripple = sin(dot(xz, vec2(0.83, 0.56)) * 3.1 + fbm2(xz * 0.5, 2) * 7.0) * 0.5 + 0.5;
    albedo = mix(albedo, albedo * (0.90 + 0.20 * ripple), wSand * lodFine);
  }
  // wear/shade under the tree line
  albedo *= 1.0 - wood * 0.16 * (1.0 - wFw) * (1.0 - wGreen);

  /* ---- normals -------------------------------------------------------- */
  vec3 Nb = N;
  // Surface bump is a close-range effect only. Carried out to mid distance it
  // turns every slope into speckle, because the derivative of a half-metre
  // noise field is large compared with a pixel footprint out there.
  if (lodBump > 0.004){
    float e = 0.5;
    float h0 = fbm2(xz * 1.4, 2);
    float hx = fbm2((xz + vec2(e,0.0)) * 1.4, 2);
    float hz = fbm2((xz + vec2(0.0,e)) * 1.4, 2);
    float amp = mix(0.42, 0.07, wGreen) * mix(1.0, 1.5, wRough) * (1.0 - wPath) * lodBump;
    vec3 bump = vec3(-(hx-h0)/e, 0.0, -(hz-h0)/e) * amp;
    // stripe normal tilt: alternate mow bands lean the blades
    Nb = normalize(N + bump);
  }
  Nb = normalize(Nb + vec3(grainDir.x, 0.0, grainDir.y) * leanSign * stripeMask * 0.34);

  /* ---- lighting ------------------------------------------------------- */
  float ndl = dot(Nb, uSunDir);
  float wrap = 0.28;
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);

  float sh = shadowFactor(vWorld, max(ndl, 0.0), viewDist);
  // soften shadow terminator on turf
  sh = mix(sh, sh * 0.5 + 0.5, 0.12);

  // anisotropic sheen along the mow direction (grass behaves like fibres)
  vec3 T = normalize(vec3(grainDir.x, 0.0, grainDir.y) - Nb * dot(Nb, vec3(grainDir.x,0.0,grainDir.y)));
  float tl = dot(T, uSunDir), tv = dot(T, V);
  float sheen = pow(clamp(sqrt(max(1.0-tl*tl,0.0))*sqrt(max(1.0-tv*tv,0.0)) - tl*tv, 0.0, 1.0), 24.0);
  float sheenAmt = (wFw*0.9 + wGreen*1.25 + wTee*0.9 + wRough*0.45) * (1.0 - wSand);

  // forward scattering: turf glows when you look toward the sun through it
  float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 3.0) * clamp(0.35 - ndl*0.35, 0.0, 1.0);
  vec3 transCol = vec3(0.40, 0.60, 0.16) * trans * (1.0 - wSand) * (1.0 - wPath);

  // sand is rougher and brighter, with a specular-free but backscattering look
  float sandSpec = pow(max(dot(reflect(-uSunDir, Nb), V), 0.0), 5.0) * wSand * 0.045;

  float ao = vAO;
  ao *= 1.0 - wood * 0.30;
  ao *= 1.0 - smoothstep(0.0, -2.5, dSa) * 0.28;     // inside bunkers
  ao = clamp(ao, 0.0, 1.0);

  vec3 skyUp   = skyRadiance(vec3(0.0, 1.0, 0.0));
  vec3 skyHz   = skyRadiance(normalize(vec3(V.x, 0.12, V.z)));
  vec3 ambient = mix(skyHz, skyUp, 0.55) * (0.56 + 0.32 * Nb.y) * ao;
  ambient += uGroundTint * 0.115 * (1.0 - Nb.y) * ao;
  // a little of the sun leaks back into shadow via ground bounce
  ambient += uSunColor * albedo * 0.085 * (1.0 - sh);

  vec3 col = albedo * (uSunColor * diff * sh * 1.20 + ambient);
  col += uSunColor * sheen * sheenAmt * sh * 0.26;
  col += uSunColor * sandSpec * sh;
  col += transCol * uSunColor * 0.55;

  /* ---- shallow water tint over the basin ------------------------------ */
  col = applyFog(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}
`;

  /* ============================================================ trees */

  const treeVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aData;      // x: 0 trunk / 1 canopy, y: blob index
layout(location=3) in vec4 iA;         // x,y,z, scale
layout(location=4) in vec4 iB;         // rotY, hue, phase, height scale

out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
out float vHue;
out float vIsCanopy;
out float vPhase;

uniform mat4 uViewProj;
uniform float uTime;
uniform float uWind;

void main(){
  float s = iA.w;
  float c = cos(iB.x), sn = sin(iB.x);
  vec3 p = aPos;
  p.xz *= s;
  p.y  *= s * iB.w;
  vec3 rp = vec3(c*p.x + sn*p.z, p.y, -sn*p.x + c*p.z);
  vec3 rn = vec3(c*aNormal.x + sn*aNormal.z, aNormal.y, -sn*aNormal.x + c*aNormal.z);

  // wind sway, stronger higher up the tree
  float h = max(p.y, 0.0) / max(s * iB.w * 9.0, 0.001);
  float t = uTime * 0.9 + iB.z;
  float sway = (sin(t) * 0.62 + sin(t * 2.31 + 1.7) * 0.28 + sin(t * 4.7 + 0.4) * 0.10);
  rp.x += sway * h * h * uWind * 0.62;
  rp.z += cos(t * 0.83 + iB.z) * h * h * uWind * 0.42;

  vWorld = iA.xyz + rp;
  vNormal = rn;
  vLocal = p / max(s, 0.001);
  vHue = iB.y;
  vIsCanopy = aData.x;
  vPhase = iB.z;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

  const treeFrag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;
in float vHue;
in float vIsCanopy;
in float vPhase;
out vec4 frag;

uniform float uExposure;
uniform float uAlphaCut;

${NOISE}
${SKY}
${SHADOW}
${FOG}

void main(){
  float viewDist = distance(uCamPos, vWorld);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);

  if (vIsCanopy > 0.5){
    // break the silhouette up with 3D noise so blobs read as foliage
    float n = vnoise3(vWorld * 1.15 + vPhase) * 0.62 + vnoise3(vWorld * 3.4 + vPhase) * 0.38;
    float n2 = vnoise3(vWorld * 6.5 - vPhase * 0.5) * 0.6 + vnoise3(vWorld * 14.0) * 0.4;
    float cut = mix(uAlphaCut, 0.06, smoothstep(90.0, 240.0, viewDist));
    float rim = 1.0 - abs(dot(N, V));
    if (n * 0.68 + n2 * 0.32 < cut + rim * 0.16) discard;

    // perturb the normal — a smooth sphere never looks like leaves
    vec3 jn = normalize(N + (vec3(
      vnoise3(vWorld * 3.1),
      vnoise3(vWorld * 3.1 + 17.0),
      vnoise3(vWorld * 3.1 + 41.0)) - 0.5) * 1.25);
    N = normalize(mix(jn, N, smoothstep(60.0, 190.0, viewDist)));

    float shade = 0.48 + 0.62 * n2;
    vec3 base = mix(vec3(0.104, 0.186, 0.062), vec3(0.246, 0.352, 0.118), vHue);
    base = mix(base, vec3(0.286, 0.372, 0.126), n * 0.45);
    // a few trees carry autumn tones, which stops the canopy reading as one mass
    base = mix(base, vec3(0.330, 0.286, 0.098), smoothstep(0.86, 1.0, vHue) * 0.55);
    // sun-bleached upper canopy, shaded underside
    base *= 0.74 + 0.56 * smoothstep(-0.4, 0.9, vLocal.y * 0.55 + 0.35);
    base *= shade;

    float ndl = dot(N, uSunDir);
    float diff = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);
    float sh = shadowFactor(vWorld, max(ndl, 0.0), viewDist);
    // leaves transmit light — the single biggest cue that a canopy is foliage
    float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 2.0) * 0.95;
    trans *= 0.35 + 0.65 * clamp(1.0 - abs(ndl), 0.0, 1.0);
    vec3 transCol = vec3(0.46, 0.74, 0.20) * trans * (0.30 + 0.70 * sh);

    // self-shadowing toward the middle of the canopy volume
    float inner = clamp(1.0 - length(vLocal.xz) * 1.15, 0.0, 1.0);
    float ao = mix(1.0, 0.58, inner) * (0.68 + 0.32 * n);

    vec3 skyUp = skyRadiance(vec3(0.0,1.0,0.0));
    vec3 skyHz = skyRadiance(normalize(vec3(V.x, 0.10, V.z)));
    vec3 ambient = mix(skyHz, skyUp, 0.62) * (0.46 + 0.32 * N.y) * ao;
    ambient += uGroundTint * 0.14 * clamp(-N.y, 0.0, 1.0);

    vec3 col = base * (uSunColor * diff * sh * 1.20 + ambient) + transCol * uSunColor * 0.60;
    // waxy leaf highlight
    float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 18.0) * 0.30 * sh;
    col += uSunColor * spec * (0.4 + 0.6 * n);
    col = applyFog(col, vWorld, -V);
    frag = vec4(col * uExposure, 1.0);
  } else {
    float g = vnoise3(vWorld * vec3(2.6, 0.5, 2.6));
    vec3 base = mix(vec3(0.136,0.108,0.086), vec3(0.226,0.186,0.150), g);
    base *= 0.72 + 0.5 * vnoise3(vWorld * vec3(9.0, 1.4, 9.0));
    float ndl = dot(N, uSunDir);
    float diff = clamp((ndl + 0.25) / 1.25, 0.0, 1.0);
    float sh = shadowFactor(vWorld, max(ndl,0.0), viewDist);
    vec3 ambient = skyRadiance(vec3(0.0,1.0,0.0)) * 0.22;
    vec3 col = base * (uSunColor * diff * sh + ambient);
    col = applyFog(col, vWorld, -V);
    frag = vec4(col * uExposure, 1.0);
  }
}`;

  /* ============================================================ impostor trees */

  const impostorVert = `
layout(location=0) in vec2 aCorner;    // -0.5..0.5
layout(location=3) in vec4 iA;         // x,y,z, radius
layout(location=4) in vec4 iB;         // rotY, hue, phase, heightScale
out vec2 vUv;
out vec3 vWorld;
out vec3 vRight;
out vec3 vUpV;
out vec3 vFace;
out float vHue;
out float vPhase;
uniform mat4 uViewProj;
uniform vec3 uCamPosB;
void main(){
  vec3 c = iA.xyz;
  float r = iA.w;
  vec3 toCam = uCamPosB - c;
  vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x));
  vec3 up = vec3(0.0, 1.0, 0.0);
  vWorld = c + right * aCorner.x * r * 2.0 + up * aCorner.y * r * 2.0 * iB.w;
  vUv = aCorner + 0.5;
  vRight = right;
  vUpV = up;
  vFace = normalize(toCam);
  vHue = iB.y;
  vPhase = iB.z;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

  const impostorFrag = `
precision highp float;
in vec2 vUv;
in vec3 vWorld;
in vec3 vRight;
in vec3 vUpV;
in vec3 vFace;
in float vHue;
in float vPhase;
out vec4 frag;
uniform float uExposure;
${NOISE}
${SKY}
${FOG}
void main(){
  vec2 p = vUv - vec2(0.5, 0.44);
  p.y *= 0.88;
  float ang = atan(p.y, p.x);
  float r = length(p);
  float lobes = 0.335 + 0.055 * sin(ang * 5.0 + vPhase * 6.0)
                      + 0.040 * sin(ang * 9.0 - vPhase * 3.0)
                      + 0.028 * sin(ang * 15.0 + vPhase);
  float n = vnoise(vUv * 11.0 + vPhase * 20.0);
  float n2 = vnoise(vUv * 30.0 - vPhase * 11.0);
  float edge = lobes * (0.86 + 0.24 * n);
  if (r > edge) discard;

  vec3 V = normalize(uCamPos - vWorld);
  // treat the billboard as a hemisphere so the light wraps like a real crown
  float k = clamp(1.0 - pow(r / max(edge, 0.001), 2.0), 0.0, 1.0);
  vec3 N = normalize(vRight * (p.x / max(edge, 0.001))
                   + vUpV  * (p.y / max(edge, 0.001))
                   + vFace * (0.55 + 0.45 * sqrt(k)));

  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);
  vec3 base = mix(vec3(0.104, 0.186, 0.062), vec3(0.246, 0.352, 0.118), vHue);
  base = mix(base, vec3(0.286, 0.372, 0.126), n * 0.45);
  base = mix(base, vec3(0.330, 0.286, 0.098), smoothstep(0.86, 1.0, vHue) * 0.55);
  base *= 0.74 + 0.56 * smoothstep(-0.4, 0.9, (p.y / max(edge,0.001)) * 0.55 + 0.35);
  base *= 0.80 + 0.30 * n2;

  float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 2.0) * 0.85;
  vec3 skyUp = skyRadiance(vec3(0.0,1.0,0.0));
  vec3 skyHz = skyRadiance(normalize(vec3(V.x, 0.10, V.z)));
  vec3 ambient = mix(skyHz, skyUp, 0.62) * (0.40 + 0.26 * N.y);
  vec3 col = base * (uSunColor * diff * 1.20 + ambient)
           + vec3(0.46,0.74,0.20) * trans * uSunColor * 0.42;
  col += uSunColor * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 18.0) * 0.22;
  col = applyFog(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================ water */

  const waterVert = `
layout(location=0) in vec3 aPos;
out vec3 vWorld;
uniform mat4 uViewProj;
void main(){ vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }`;

  const waterFrag = `
precision highp float;
in vec3 vWorld;
out vec4 frag;
uniform float uExposure;
uniform float uTime;
uniform sampler2D uFieldA;
uniform vec4 uFieldRect;
${NOISE}
${SKY}
${SHADOW}
${FOG}

void main(){
  vec2 xz = vWorld.xz;
  float dWa = texture(uFieldA, (xz - uFieldRect.xy) * uFieldRect.w).w;
  if (dWa > 0.0) discard;

  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);

  // two scrolling ripple layers
  vec2 w1 = xz * 0.85 + vec2(uTime * 0.11, uTime * 0.07);
  vec2 w2 = xz * 1.9  - vec2(uTime * 0.09, uTime * 0.14);
  float e = 0.16;
  float h = fbm2(w1, 3) * 0.6 + fbm2(w2, 3) * 0.4;
  float hx = fbm2(w1 + vec2(e,0), 3) * 0.6 + fbm2(w2 + vec2(e,0), 3) * 0.4;
  float hz = fbm2(w1 + vec2(0,e), 3) * 0.6 + fbm2(w2 + vec2(0,e), 3) * 0.4;
  float amp = 0.11 * (1.0 - smoothstep(30.0, 260.0, viewDist));
  vec3 N = normalize(vec3(-(hx - h) / e * amp, 1.0, -(hz - h) / e * amp));

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.86 + 0.02;
  vec3 refl = skyRadiance(normalize(R));
  refl += uSunColor * pow(max(dot(normalize(R), uSunDir), 0.0), 480.0) * 6.0;

  float f = 0.024 + 0.976 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

  // depth-tinted body colour
  float depth = clamp(-dWa / 9.0, 0.0, 1.0);
  vec3 deep = vec3(0.028, 0.076, 0.070);
  vec3 shallow = vec3(0.108, 0.176, 0.132);
  vec3 body = mix(shallow, deep, depth);

  vec3 col = mix(body, refl, clamp(f, 0.0, 1.0));

  // shoreline: wet edge and a hint of foam
  float edge = 1.0 - smoothstep(0.0, 1.5, -dWa);
  col = mix(col, col * 0.72 + vec3(0.16,0.17,0.14), edge * 0.5);

  float sh = shadowFactor(vWorld, 1.0, viewDist);
  col *= mix(0.72, 1.0, sh);
  col = applyFog(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================ generic props */

  const propVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aWave;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uTimeP;
uniform float uWindP;
void main(){
  vec3 p = aPos;
  if (aWave > 0.0){
    float t = uTimeP * 5.2;
    float ripple = sin(t - aPos.x * 7.0 - aPos.z * 7.0) * 0.055
                 + sin(t * 1.7 - (aPos.x + aPos.z) * 13.0) * 0.022;
    p.y += ripple * aWave * (0.6 + uWindP);
    p.x += ripple * aWave * 0.35;
    p.z += ripple * aWave * 0.35;
  }
  vec4 w = uModel * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uViewProj * w;
}`;

  const propFrag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
out vec4 frag;
uniform float uExposure;
uniform float uEmissive;
uniform float uRough;
${NOISE}
${SKY}
${SHADOW}
${FOG}
void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);
  float ndl = dot(N, uSunDir);
  float diff = clamp(ndl, 0.0, 1.0);
  float sh = shadowFactor(vWorld, max(ndl,0.0), viewDist);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N,H),0.0), mix(220.0, 14.0, uRough)) * mix(0.55, 0.06, uRough);
  vec3 ambient = skyRadiance(vec3(0.0,1.0,0.0)) * (0.34 + 0.26*N.y)
               + uGroundTint * 0.09 * (1.0 - N.y);
  vec3 col = vColor * (uSunColor * diff * sh * 1.25 + ambient);
  col += uSunColor * spec * sh;
  col += vColor * uEmissive;
  col = applyFog(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================ grass tufts */

  const grassVert = `
layout(location=0) in vec3 aPos;       // blade-local, y up, 0..1
layout(location=1) in float aT;        // 0 root .. 1 tip
layout(location=3) in vec4 iA;         // x,y,z, height
layout(location=4) in vec4 iB;         // rotY, bendX, bendZ, hue
out vec3 vWorld;
out vec3 vNormal;
out float vT;
out float vHue;
uniform mat4 uViewProj;
uniform float uTime;
uniform float uWind;
void main(){
  float c = cos(iB.x), s = sin(iB.x);
  vec3 p = aPos;
  p.y *= iA.w;
  // blades stay a constant width in metres rather than scaling with height,
  // otherwise short turf turns into invisible needles
  p.xz *= 1.35;
  float t = aT * aT;
  float ph = iA.x * 0.7 + iA.z * 0.9;
  float gust = sin(uTime * 1.6 + ph) * 0.5 + sin(uTime * 3.1 + ph * 1.7) * 0.28;
  p.x += (iB.y + gust * uWind * 0.55) * t * iA.w;
  p.z += (iB.z + gust * uWind * 0.35) * t * iA.w;
  vec3 rp = vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z);
  vWorld = iA.xyz + rp;
  // strongly up-facing so a blade reads as lit turf, not a dark sliver
  vNormal = normalize(vec3(-s * 0.45, 1.0, -c * 0.45));
  vT = aT;
  vHue = iB.w;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

  const grassFrag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vT;
in float vHue;
out vec4 frag;
uniform float uExposure;
${NOISE}
${SKY}
${SHADOW}
${FOG}
void main(){
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);
  // The blade normal is deliberately up-biased. Do NOT two-side it against the
  // view vector: at eye level the horizontal component dominates, the normal
  // flips under the ground and every blade goes black.
  vec3 N = normalize(vNormal);

  vec3 base = mix(vec3(0.150,0.196,0.090), vec3(0.252,0.276,0.134), vHue);
  base = mix(base * 0.80, base * 1.18, vT);

  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + 0.42) / 1.42, 0.0, 1.0);
  float sh = shadowFactor(vWorld, max(ndl,0.0), viewDist);
  sh = mix(sh, 1.0, 0.25);
  float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 2.2) * vT;
  vec3 skyUp = skyRadiance(vec3(0.0,1.0,0.0));
  vec3 ambient = skyUp * (0.34 + 0.22 * vT);
  vec3 col = base * (uSunColor * diff * sh * 1.20 + ambient);
  col += vec3(0.46,0.70,0.20) * trans * uSunColor * 0.7;
  col = applyFog(col, vWorld, -V);
  // fade the whole layer out with distance so there is no popping edge
  float a = 1.0 - smoothstep(12.0, 20.0, viewDist);
  if (a < 0.02) discard;
  frag = vec4(col * uExposure, a);
}`;

  /* ============================================================ shadow pass */

  const shadowVert = `
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uModel;
void main(){ gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;

  const shadowTreeVert = `
layout(location=0) in vec3 aPos;
layout(location=3) in vec4 iA;
layout(location=4) in vec4 iB;
uniform mat4 uViewProj;
void main(){
  float s = iA.w;
  float c = cos(iB.x), sn = sin(iB.x);
  vec3 p = aPos; p.xz *= s; p.y *= s * iB.w;
  vec3 rp = vec3(c*p.x + sn*p.z, p.y, -sn*p.x + c*p.z);
  gl_Position = uViewProj * vec4(iA.xyz + rp, 1.0);
}`;

  const shadowFrag = `
precision highp float;
void main(){}`;

  /* ============================================================ tracer ribbon */

  const tracerVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aSide;   // x: -1/1 across ribbon, y: 0..1 along
layout(location=2) in vec3 aDir;
out float vAcross;
out float vAlong;
out vec3 vWorld;
uniform mat4 uViewProj;
uniform vec3 uCamPosT;
uniform float uWidth;
uniform float uProgress;
void main(){
  vec3 toCam = normalize(uCamPosT - aPos);
  vec3 side = normalize(cross(normalize(aDir), toCam));
  float w = uWidth * mix(0.35, 1.0, smoothstep(0.0, 0.10, aSide.y));
  vec3 p = aPos + side * aSide.x * w;
  vAcross = aSide.x;
  vAlong = aSide.y;
  vWorld = p;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

  const tracerFrag = `
precision highp float;
in float vAcross;
in float vAlong;
in vec3 vWorld;
out vec4 frag;
uniform vec3 uColor;
uniform float uProgress;
uniform float uExposure;
void main(){
  if (vAlong > uProgress) discard;
  float core = 1.0 - smoothstep(0.0, 1.0, abs(vAcross));
  float a = pow(core, 1.6);
  // comet head + fading tail
  float head = smoothstep(uProgress - 0.055, uProgress, vAlong);
  float tail = smoothstep(0.0, 0.42, vAlong / max(uProgress, 0.001));
  a *= mix(0.30, 1.0, tail);
  vec3 col = mix(uColor, vec3(1.0), head * 0.85 + pow(core, 6.0) * 0.5);
  frag = vec4(col * (1.0 + head * 2.4) * uExposure, a * (0.62 + head * 0.38));
}`;

  /* ============================================================ post */

  const fsqVert = `
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const brightFrag = `
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex;
uniform float uThreshold;
void main(){
  vec3 c = texture(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(l - uThreshold, 0.0) / max(l, 0.0001);
  frag = vec4(c * k, 1.0);
}`;

  const blurFrag = `
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uDir;
void main(){
  vec3 s = texture(uTex, vUv).rgb * 0.2270270270;
  s += texture(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  s += texture(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  s += texture(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  s += texture(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  frag = vec4(s, 1.0);
}`;

  const compositeFrag = `
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomAmt;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
${TONEMAP}

vec3 fetch(vec2 uv){ return texture(uTex, uv).rgb; }

void main(){
  vec3 c = fetch(vUv);
  c += texture(uBloom, vUv).rgb * uBloomAmt;

  c = aces(c);

  // FXAA on the tonemapped image
  float lM = dot(c, vec3(0.299,0.587,0.114));
  float lN = dot(aces(fetch(vUv + vec2(0.0, -uTexel.y))), vec3(0.299,0.587,0.114));
  float lS = dot(aces(fetch(vUv + vec2(0.0,  uTexel.y))), vec3(0.299,0.587,0.114));
  float lW = dot(aces(fetch(vUv + vec2(-uTexel.x, 0.0))), vec3(0.299,0.587,0.114));
  float lE = dot(aces(fetch(vUv + vec2( uTexel.x, 0.0))), vec3(0.299,0.587,0.114));
  float lMin = min(lM, min(min(lN,lS), min(lW,lE)));
  float lMax = max(lM, max(max(lN,lS), max(lW,lE)));
  if (lMax - lMin > max(0.028, lMax * 0.135)){
    vec2 dir = normalize(vec2(-((lN + lS) - (lW + lE)), ((lN + lS) - (lW + lE))) + 1e-6);
    dir = vec2(-(lN - lS), (lE - lW));
    float rl = 1.0 / (max(abs(dir.x), abs(dir.y)) + 1e-4);
    dir = clamp(dir * rl, -3.0, 3.0) * uTexel;
    vec3 a = 0.5 * (aces(fetch(vUv + dir * (1.0/3.0 - 0.5))) + aces(fetch(vUv + dir * (2.0/3.0 - 0.5))));
    vec3 b = a * 0.5 + 0.25 * (aces(fetch(vUv - dir * 0.5)) + aces(fetch(vUv + dir * 0.5)));
    float lb = dot(b, vec3(0.299,0.587,0.114));
    c = (lb < lMin || lb > lMax) ? a : b;
  }

  // grade
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);

  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * uVignette;
  c *= vig;

  // subtle film grain keeps large flat skies from banding
  float g = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * 0.006;

  frag = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0/2.2)), 1.0);
}`;

  root.SH = {
    skyVert, skyFrag,
    terrainVert, terrainFrag,
    treeVert, treeFrag,
    impostorVert, impostorFrag,
    waterVert, waterFrag,
    propVert, propFrag,
    grassVert, grassFrag,
    shadowVert, shadowTreeVert, shadowFrag,
    tracerVert, tracerFrag,
    fsqVert, brightFrag, blurFrag, compositeFrag
  };
})(window);
