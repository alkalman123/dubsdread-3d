/* GLSL for the hole-1 proof of concept.
 *
 * A complete replacement for js/shaders.js rather than a patch, so the two can
 * be read side by side. What changed, and why:
 *
 *  1. One atmosphere.  The sky, the direct sun colour, the ambient fill and the
 *     distance haze are all evaluated from the same single-scattering model
 *     (see sky-model.js). Previously the sky was a lerp between two authored
 *     colours and the haze was a third colour multiplied by 0.88.
 *  2. Clouds live in the world, not on a dome, so they can cast shadows. Their
 *     shadow is the single biggest change to how the scene reads: a golf hole
 *     under a broken sky has drifting light across it, and a uniformly lit
 *     fairway is the strongest tell that you are looking at a render.
 *  3. Screen-space ambient occlusion, applied to the ambient term only, using
 *     last frame's depth. Contact darkening at trunk bases, bunker lips, the
 *     collar of a raised green and under the ball.
 *  4. Turf is a two-lobe anisotropic BRDF over a clumped albedo with a real
 *     height field for the blade grain, plus wear, dew and a scar layer the
 *     game paints divots and pitch marks into.
 *  5. Depth of field with photographic controls, and volumetric shafts through
 *     the tree line.
 *  6. AgX tonemapping instead of ACES. ACES pushes saturated foliage green
 *     toward yellow, which is most of why the original reads as a video game.
 */
(function (root) {
  'use strict';

  /* ============================================================ noise */

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
/* Rotated-octave fbm. The axis-aligned lattice of plain value noise is very
   visible on turf at grazing angles; rotating each octave breaks it up. */
float fbm2r(vec2 p, int oct){
  const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
  float a=0.5, s=0.0, n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*vnoise(p); n+=a; p=R*p*2.07; a*=0.5; }
  return s/n;
}
float ridged(vec2 p, int oct){
  float a=0.5,s=0.0,n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct)break; s+=a*(1.0-abs(vnoise(p)*2.0-1.0)); n+=a; p*=2.11; a*=0.5; }
  return s/n;
}`;

  /* ============================================================ atmosphere
   * A direct transcription of sky-model.js. The JS side computes exposure and
   * the HUD readout from the same equations, so the two cannot disagree.
   */

  const ATMOS = `
#define PI 3.14159265359
uniform vec3  uSunDir;        // unit vector toward the sun
uniform vec3  uSunColor;      // direct beam after extinction (JS: sunColor)
uniform vec3  uTauR;          // vertical Rayleigh+ozone optical depth, per channel
uniform float uTauM;          // vertical Mie optical depth
uniform float uSkyGain;
uniform float uTwilight;      // 0 while the sun is up
uniform vec3  uGroundTint;
uniform float uExposure;
uniform vec3  uCamPos;

const float MIE_G = 0.50;
const float MIE_SSA = 0.86;
const vec3  E0 = vec3(1.86, 1.83, 1.79);

float airMass(float cosZ){
  float el = degrees(asin(clamp(cosZ, -1.0, 1.0)));
  return 1.0 / (max(cosZ, 0.0) + 0.50572 * pow(max(el, -5.0) + 6.07995, -1.6364));
}
float phaseR(float mu){ return 3.0/(16.0*PI) * (1.0 + mu*mu); }
float phaseM(float mu){
  float gg = MIE_G*MIE_G;
  return 3.0/(8.0*PI) * ((1.0-gg)*(1.0+mu*mu))
       / ((2.0+gg)*pow(max(1.0+gg-2.0*MIE_G*mu, 1e-4), 1.5));
}
vec3 beamTransmittance(float cosZ){
  float am = airMass(cosZ);
  return exp(-(uTauR + vec3(uTauM)) * am);
}

vec3 skyRadiance(vec3 dir){
  dir = normalize(dir);
  float up = dir.y;
  float am = airMass(max(up, 0.0));
  if (up < 0.0) am = mix(am, airMass(0.0) * 1.4, clamp(-up / 0.12, 0.0, 1.0));

  float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);
  float pr = phaseR(mu), pm = phaseM(mu);
  vec3 sunT = beamTransmittance(uSunDir.y);

  float msc = 1.0 + 0.34 * (1.0 - exp(-am * 0.45));

  vec3 den = uTauR + vec3(uTauM);
  vec3 ext = exp(-den * am);
  vec3 num = uTauR * pr + vec3(uTauM * MIE_SSA * pm);
  vec3 L = E0 * sunT * (num / den) * (1.0 - ext) * uSkyGain * msc;
  L += E0 * uTwilight * (uTauR / den) * (1.0 - ext) * uSkyGain;
  return L;
}

/* The disc itself, with limb darkening. Radius is the true 0.267 degrees. */
vec3 sunDisc(vec3 dir){
  float mu = dot(normalize(dir), uSunDir);
  const float cosR = 0.99998915;                 // cos(0.267 deg)
  float edge = smoothstep(cosR - 0.000035, cosR + 0.000012, mu);
  float r = sqrt(max(1.0 - mu*mu, 0.0)) / 0.00466;
  float limb = 1.0 - 0.62 * (1.0 - sqrt(max(1.0 - min(r*r, 1.0), 0.0)));
  vec3 beam = E0 * beamTransmittance(uSunDir.y);
  // a real forward-scattered aureole rather than a fixed-width glow
  float aureole = pow(max(mu, 0.0), 900.0) * 0.9 + pow(max(mu, 0.0), 60.0) * 0.045;
  return beam * (edge * limb * 26.0 + aureole * 7.0);
}`;

  /* ============================================================ clouds
   * The field is defined on a world-space plane at cloud altitude and both the
   * sky and the ground shadow evaluate it at the point where their own ray
   * crosses that plane. That is the whole trick: because the two agree, a cloud
   * you can see overhead is the cloud whose shadow is crossing the fairway.
   */

  const CLOUDS = `
uniform float uCloudCover;
uniform float uCloudAlt;
uniform vec2  uCloudDrift;
uniform float uCloudScale;
uniform float uCloudShadow;    // 0..1 strength
uniform vec3  uCloudFill;      // diffuse light the deck itself throws down
uniform float uTime;

float cloudDensity(vec2 p){
  vec2 uv = p * uCloudScale + uCloudDrift;
  float base = fbm2r(uv, 4);
  float det  = fbm2r(uv * 3.35 + base * 0.55, 3);
  float c = base * 0.70 + det * 0.30;
  return smoothstep(0.585 - uCloudCover * 0.40, 0.845 - uCloudCover * 0.30, c);
}

/**
 * Fraction of the beam surviving the cloud deck above a world point.
 * The sun is half a degree wide, so at 1.5 km its penumbra is about 13 m; three
 * taps spread across that width read as a soft edge rather than a stencil.
 */
float cloudShadow(vec3 world){
  if (uCloudShadow < 0.001 || uSunDir.y < 0.03) return 1.0;
  float t = (uCloudAlt - world.y) / max(uSunDir.y, 0.03);
  vec2 hit = world.xz + uSunDir.xz * t;
  float d = cloudDensity(hit) * 0.44
          + cloudDensity(hit + vec2(11.0, -6.0)) * 0.28
          + cloudDensity(hit + vec2(-8.0, 9.5)) * 0.28;
  return 1.0 - d * uCloudShadow;
}

vec4 clouds(vec3 dir){
  if (dir.y < 0.012) return vec4(0.0);
  float t = (uCloudAlt - uCamPos.y) / dir.y;
  if (t <= 0.0) return vec4(0.0);
  vec2 hit = uCamPos.xz + dir.xz * t;
  float d = cloudDensity(hit);
  if (d < 0.002) return vec4(0.0);

  // self-shadowing: march the field toward the sun so bases go dark and the
  // edge facing the sun lights up
  float occ = 0.0;
  occ += cloudDensity(hit + uSunDir.xz * 240.0) * 0.5;
  occ += cloudDensity(hit + uSunDir.xz * 620.0) * 0.3;
  occ += cloudDensity(hit + uSunDir.xz * 1300.0) * 0.2;

  vec3 beam = E0 * beamTransmittance(uSunDir.y);
  vec3 lit   = beam * (1.0 - occ * 0.78) * 0.92;
  vec3 shade = skyRadiance(vec3(dir.x, max(dir.y, 0.05), dir.z)) * 1.15;
  vec3 col = mix(shade, lit, clamp(1.0 - occ * 0.9, 0.0, 1.0) * 0.85 + 0.15);

  // silver lining where the deck is thin and the sun is behind it
  float mu = dot(normalize(dir), uSunDir);
  col += beam * pow(max(mu, 0.0), 22.0) * (1.0 - d) * 1.6;

  float a = d * smoothstep(0.012, 0.085, dir.y);
  a *= 1.0 - smoothstep(24000.0, 70000.0, t);      // dissolve into the horizon
  return vec4(col, a);
}`;

  /* ============================================================ shadows */

  const SHADOW = `
uniform sampler2D uShadow0;
uniform sampler2D uShadow1;
uniform mat4 uShadowVP0;
uniform mat4 uShadowVP1;
uniform vec2 uShadowTexel;
uniform float uCascadeSplit;

float pcf(sampler2D smap, vec3 pc, float bias, float radius){
  if (pc.x < 0.003 || pc.x > 0.997 || pc.y < 0.003 || pc.y > 0.997) return 1.0;
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
}

/** Everything between this point and the sun: geometry and weather. */
float sunVisibility(vec3 world, float ndl, float viewDist){
  return shadowFactor(world, ndl, viewDist) * cloudShadow(world);
}`;

  /* ============================================================ SSAO fetch */

  const AOTEX = `
uniform sampler2D uAOTex;
uniform vec2 uAOTexel;
uniform float uAOEnabled;
float screenAO(){
  if (uAOEnabled < 0.5) return 1.0;
  return texture(uAOTex, gl_FragCoord.xy * uAOTexel).r;
}`;

  /* ============================================================ aerial perspective
   * Not a fog colour: the same air the sky is made of, integrated over the
   * distance to the surface. Because extinction is per channel, a far tree line
   * loses its red first and goes blue-grey, and at golden hour the inscattered
   * light along the view ray is orange because the phase function says so.
   */

  const AERIAL = `
uniform float uFogDensity;
uniform float uFogHeight;

/**
 * Haze lives in the boundary layer, not all the way up.
 *
 * A scale height of about 130 m is what makes a view along the ground hazy and
 * a view down from a drone almost clear — get this wrong and an aerial shot
 * turns into milk, because the whole path is credited with sea-level haze.
 * The per-channel extinction is part way toward the atmosphere's own, so a far
 * tree line loses its red first and goes blue-grey rather than simply pale.
 */
vec3 applyAerial(vec3 col, vec3 world, vec3 viewDir){
  float d = distance(world, uCamPos);
  float hAvg = max((world.y + uCamPos.y) * 0.5, 0.0);
  float scale = uFogDensity * exp(-hAvg * uFogHeight);

  vec3 ratio = (uTauR + vec3(uTauM)) / (uTauR.g + uTauM);
  vec3 beta = pow(ratio, vec3(0.55)) * scale;
  vec3 tr = exp(-beta * d);

  /* Inscattering for *this* path, not for the whole sky.
   *
   * Using skyRadiance() as the haze colour is the obvious thing and it is wrong
   * for any ray that is not looking at the horizon: that function already
   * integrates the entire atmosphere, so multiplying it by the short path's
   * (1 - transmittance) double-counts. Looking down from a drone the view
   * direction is forced below the horizon, the air mass goes to fifty, and a
   * saturated horizon radiance gets added on top of ground that is barely hazy
   * at all — the whole frame turns to milk.
   *
   * The source term below is the same expression skyRadiance is built from —
   * the two phase functions weighted by their scattering coefficients, lit by
   * what is left of the beam — but scaled by the path actually travelled. At
   * long range it converges to the sky, which is what makes a distant tree line
   * dissolve into the horizon correctly; over a few hundred metres of downward
   * view it stays almost clear, which is what a drone shot looks like. */
  float mu = clamp(dot(normalize(viewDir), uSunDir), -1.0, 1.0);
  vec3 den = uTauR + vec3(uTauM);
  vec3 num = uTauR * phaseR(mu) + vec3(uTauM * MIE_SSA * phaseM(mu));
  vec3 J = E0 * beamTransmittance(uSunDir.y) * (num / den) * uSkyGain * 1.02;
  // a floor so the shadowed side of the haze does not go black at a low sun
  J += E0 * uSkyGain * 0.008 * (uTauR / den);

  return col * tr + J * (1.0 - tr);
}`;

  /* ============================================================ tonemap
   * AgX (Troy Sobotka), the six-term polynomial approximation of the sigmoid.
   * Chosen over ACES because ACES's RRT skews saturated greens toward yellow as
   * they brighten, which is exactly the range a sunlit fairway occupies.
   */

  const TONEMAP = `
const mat3 AGX_IN = mat3(
  0.842479062253094, 0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772, 0.0784336000000000,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const mat3 AGX_OUT = mat3(
   1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
  -0.0990297440797205,-0.0989611768448433,  1.15107367264116);

vec3 agxContrast(vec3 x){
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5     * x4 * x2
        - 40.14    * x4 * x
        + 31.96    * x4
        -  6.868   * x2 * x
        +  0.4298  * x2
        +  0.1191  * x
        -  0.00232;
}
vec3 agx(vec3 col){
  const float MIN_EV = -12.47393, MAX_EV = 4.026069;
  col = AGX_IN * max(col, 0.0);
  col = clamp(log2(col + 1e-10), MIN_EV, MAX_EV);
  col = (col - MIN_EV) / (MAX_EV - MIN_EV);
  return agxContrast(col);
}
vec3 agxLook(vec3 col, float sat, float punch){
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, sat);
  return pow(max(col, 0.0), vec3(punch));
}
vec3 agxOut(vec3 col){ return max(AGX_OUT * col, 0.0); }

vec3 aces(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}`;

  /* ============================================================ sky pass */

  const skyVert = `
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 1.0, 1.0); }`;

  const skyFrag = `
precision highp float;
in vec2 vNdc;
out vec4 frag;
uniform mat4 uInvViewProj;
${NOISE}
${ATMOS}
${CLOUDS}
void main(){
  vec4 p0 = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 p1 = uInvViewProj * vec4(vNdc,  1.0, 1.0);
  vec3 dir = normalize(p1.xyz / p1.w - p0.xyz / p0.w);

  vec3 col = skyRadiance(dir);
  // ground haze below the horizon so the world does not end at a hard line
  if (dir.y < 0.0){
    vec3 g = uGroundTint * 2.6 + skyRadiance(vec3(dir.x, 0.02, dir.z)) * 0.55;
    col = mix(col, g, clamp(-dir.y * 5.0, 0.0, 0.92));
  }
  vec3 disc = sunDisc(dir);
  vec4 cl = clouds(dir);
  col = mix(col, cl.rgb, cl.a);
  col += disc * (1.0 - cl.a * 0.88);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================ depth-only */

  const depthVert = `
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uModel;
void main(){ gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;

  const depthTreeVert = `
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

  const depthFrag = `
precision highp float;
void main(){}`;

  /* ============================================================ SSAO
   * Horizon-style hemisphere occlusion from the depth buffer. Runs at half
   * resolution off the previous frame's depth, which costs one texture read per
   * sample instead of a second pass over every triangle in the scene; a term
   * this soft does not care about a frame of latency.
   */

  const ssaoFrag = `
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform vec3 uCamPosA;
uniform vec2 uDepthTexel;
uniform float uRadius;      // metres
uniform float uStrength;
uniform float uFrame;

vec3 worldAt(vec2 uv, out bool sky){
  float d = texture(uDepth, uv).r;
  sky = d >= 0.99999;
  vec4 c = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return c.xyz / c.w;
}

void main(){
  bool sky;
  vec3 P = worldAt(vUv, sky);
  if (sky){ frag = vec4(1.0); return; }

  // Normal from the depth buffer. Two-sided differences pick the closer
  // neighbour on each axis so silhouettes do not produce a normal that faces
  // halfway into the background.
  bool s1;
  vec3 pxr = worldAt(vUv + vec2(uDepthTexel.x, 0.0), s1);
  vec3 pxl = worldAt(vUv - vec2(uDepthTexel.x, 0.0), s1);
  vec3 pyu = worldAt(vUv + vec2(0.0, uDepthTexel.y), s1);
  vec3 pyd = worldAt(vUv - vec2(0.0, uDepthTexel.y), s1);
  vec3 dx = (length(pxr - P) < length(P - pxl)) ? pxr - P : P - pxl;
  vec3 dy = (length(pyu - P) < length(P - pyd)) ? pyu - P : P - pyd;
  vec3 N = normalize(cross(dy, dx));
  if (dot(N, uCamPosA - P) < 0.0) N = -N;

  float viewDist = distance(P, uCamPosA);
  // hold the kernel's screen footprint roughly constant, but never let it grow
  // past a couple of metres of world space or it stops being contact shading
  float radius = clamp(uRadius * (1.0 + viewDist * 0.010), uRadius, uRadius * 4.0);

  float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453
                    + uFrame * 0.618) * 6.2831853;
  float ca = cos(ang), sa = sin(ang);

  vec3 T = normalize(abs(N.y) < 0.95 ? cross(N, vec3(0.0,1.0,0.0)) : vec3(1.0,0.0,0.0));
  vec3 B = cross(N, T);

  const int NS = 12;
  float occ = 0.0;
  for (int i = 0; i < NS; i++){
    float fi = (float(i) + 0.5) / float(NS);
    float a = fi * 6.2831853 * 3.0;
    vec2 d2 = vec2(cos(a), sin(a));
    d2 = vec2(d2.x * ca - d2.y * sa, d2.x * sa + d2.y * ca);
    float r = sqrt(fi) * radius;
    float h = 0.28 + 0.72 * fi;
    vec3 sp = P + (T * d2.x + B * d2.y) * r + N * (r * h * 0.55 + 0.02);

    vec4 cp = uViewProj * vec4(sp, 1.0);
    if (cp.w <= 0.0) continue;
    vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
    if (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) continue;

    bool ssky;
    vec3 sw = worldAt(suv, ssky);
    if (ssky) continue;

    // occluded if the geometry actually on screen there is nearer to the eye
    float dSample = distance(sw, uCamPosA);
    float dPoint  = distance(sp, uCamPosA);
    float diff = dPoint - dSample;
    if (diff > 0.02){
      // range check: a distant wall behind a near object must not occlude it
      float w = 1.0 - smoothstep(radius * 0.9, radius * 2.2, diff);
      occ += w * (0.35 + 0.65 * (1.0 - fi));
    }
  }
  occ = occ / float(NS) * uStrength * 2.1;
  // fade AO out with distance; beyond a hundred metres a pixel covers more
  // ground than the kernel radius and the term becomes noise
  occ *= 1.0 - smoothstep(90.0, 260.0, viewDist);
  frag = vec4(vec3(clamp(1.0 - occ, 0.0, 1.0)), 1.0);
}`;

  const ssaoBlurFrag = `
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTex;
uniform sampler2D uDepth;
uniform vec2 uDir;
void main(){
  float dc = texture(uDepth, vUv).r;
  float sum = texture(uTex, vUv).r, w = 1.0;
  for (int i = 1; i <= 3; i++){
    vec2 o = uDir * float(i);
    for (int s = -1; s <= 1; s += 2){
      vec2 uv = vUv + o * float(s);
      float d = texture(uDepth, uv).r;
      // depth-aware so the blur does not bleed occlusion across a silhouette
      float ww = exp(-abs(d - dc) * 900.0) * (1.0 - float(i) * 0.22);
      sum += texture(uTex, uv).r * ww;
      w += ww;
    }
  }
  frag = vec4(vec3(sum / w), 1.0);
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
uniform vec2  uMowDir;
uniform float uDetail;        // 1 = near field, 0 = distant context
uniform float uDew;           // 0..1, dawn moisture on the turf
uniform vec4  uCup;           // the hole: centre xyz, radius (0 = none)

/* Divots, pitch marks and foot traffic the game paints as it is played. */
uniform sampler2D uScar;
uniform vec4  uScarRect;
uniform float uScarOn;

${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AOTEX}
${AERIAL}

vec4 fieldA(vec2 xz){ return texture(uFieldA, (xz - uFieldRect.xy) * uFieldRect.w); }
vec4 fieldB(vec2 xz){ return texture(uFieldB, (xz - uFieldRect.xy) * uFieldRect.w); }

float stripe(vec2 xz, vec2 dir, float period){
  float t = dot(xz, vec2(-dir.y, dir.x));
  return sin(t * 6.2831853 / period);
}

/**
 * Blade-grain height field.
 *
 * The original shaded mown turf as a smooth surface with a noise bump. Real
 * mown grass is a dense field of near-vertical fibres, and what the eye picks
 * up at 2 m is the shading of individual clumps. This is a cheap stand-in: a
 * high-frequency cellular field whose gradient tilts the normal, faded out by
 * pixel footprint so it never aliases.
 */
float bladeGrain(vec2 xz, float scale, out vec2 grad){
  vec2 p = xz * scale;
  float h0 = vnoise(p) * 0.6 + vnoise(p * 2.7 + 11.0) * 0.4;
  float e = 0.35;
  float hx = vnoise(p + vec2(e,0.0)) * 0.6 + vnoise((p + vec2(e,0.0)) * 2.7 + 11.0) * 0.4;
  float hz = vnoise(p + vec2(0.0,e)) * 0.6 + vnoise((p + vec2(0.0,e)) * 2.7 + 11.0) * 0.4;
  grad = vec2(hx - h0, hz - h0) / e;
  return h0;
}

void main(){
  vec2 xz = vWorld.xz;
  // the green is cut open over the cup, so the cup underneath can be seen
  if (uCup.w > 0.0 && distance(xz, uCup.xz) < uCup.w) discard;
  vec4 A = fieldA(xz);
  vec4 B = fieldB(xz);
  float dFw = A.x, dGr = A.y, dSa = A.z, dWa = A.w;
  float dTe = B.x, dPa = B.y, dCo = B.z, wood = B.w;

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);

  float px = max(max(abs(dFdx(xz.x)), abs(dFdy(xz.x))),
                 max(abs(dFdx(xz.y)), abs(dFdy(xz.y)))) + 1e-5;
  #define LOD(wave) (1.0 - smoothstep((wave) * 0.35, (wave) * 1.30, px))
  float lodMicro = LOD(0.16);
  float lodFine  = LOD(1.55);
  float lodBump  = LOD(0.72);
  float lodBlade = LOD(0.055);

  /* ---- surface weights ------------------------------------------------ */
  float wGreen  = 1.0 - smoothstep(-0.35, 0.10, dGr);
  float wFringe = (1.0 - wGreen) * (1.0 - smoothstep(0.55, 1.60, dGr));
  // A bunker edge is cut with an edger and is a few centimetres wide, not half
  // a metre. The soft transition was reading as sand fading into grass.
  float wSand   = 1.0 - smoothstep(-0.09, 0.07, dSa);
  float wTee    = (1.0 - smoothstep(-0.25, 0.25, dTe)) * (1.0 - wGreen);
  float wPath   = 1.0 - smoothstep(-0.15, 0.30, dPa);
  float wFw     = 1.0 - smoothstep(-0.35, 0.35, dFw);
  // The first cut. Its outer edge is a mowing line, and a mower leaves an edge,
  // not a gradient — tightening the far side is what makes a fairway read as
  // something that was cut rather than something that was painted.
  float wCut    = (1.0 - wFw) * (1.0 - smoothstep(2.4, 3.4, dFw));
  float wRough  = 1.0 - smoothstep(-0.5, 6.0, dCo);
  float wTurf   = (1.0 - wSand) * (1.0 - wPath);

  /* ---- albedo ---------------------------------------------------------
   * Clumping in hue as well as brightness. A single-species monoculture is
   * what makes CG turf read as felt; real fairway is a mix with patches that
   * differ in colour, not just in tone.
   */
  float turfA = fbm2r(xz * 0.020, 3);
  float turfB = fbm2r(xz * 0.085 + 31.7, 3);
  float clump = fbm2r(xz * 0.42 + 7.3, 2);
  float fine  = lodFine  > 0.004 ? fbm2r(xz * 0.65, 2) : 0.5;
  float micro = lodMicro > 0.004 ? vnoise(xz * 3.2)     : 0.5;

  vec3 cGreen  = mix(vec3(0.186,0.318,0.118), vec3(0.258,0.408,0.150), turfB);
  vec3 cFairway= mix(vec3(0.168,0.288,0.092), vec3(0.248,0.380,0.128), turfA);
  vec3 cRough  = mix(vec3(0.088,0.158,0.052), vec3(0.142,0.222,0.076), turfA);
  vec3 cNative = mix(vec3(0.120,0.180,0.074), vec3(0.196,0.252,0.110), turfB);
  vec3 cTee    = mix(vec3(0.146,0.260,0.086), vec3(0.208,0.336,0.120), turfB);
  // washed bunker sand: bright, warm, and desaturated rather than beige-green
  vec3 cSand   = mix(vec3(0.570,0.505,0.386), vec3(0.735,0.678,0.552), turfB*0.7+fine*0.3);
  // weathered asphalt, not concrete: a 0.45-albedo path blows out in full sun
  vec3 cPath   = mix(vec3(0.230,0.226,0.216), vec3(0.320,0.316,0.302), fine);

  // poa patches: a yellower, coarser grass that invades bent fairways
  float poa = smoothstep(0.62, 0.86, clump) * (1.0 - wGreen * 0.55);
  cFairway = mix(cFairway, vec3(0.286, 0.372, 0.146), poa * 0.34);
  cGreen   = mix(cGreen,   vec3(0.268, 0.396, 0.176), poa * 0.28);
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

  /* ---- mowing ---------------------------------------------------------- */
  vec2 grainDir = uMowDir;
  float sFw = stripe(xz, uMowDir, 7.2);
  vec2 crossDir = normalize(uMowDir + vec2(uMowDir.y, -uMowDir.x));
  float sGr = stripe(xz, crossDir, 2.05);
  // greens are double-cut: a second pass at right angles to the first
  float sGr2 = stripe(xz, vec2(-crossDir.y, crossDir.x), 2.05);
  float sRo = stripe(xz, uMowDir, 13.0);

  sFw = sign(sFw) * pow(abs(sFw), 0.55);
  sGr = sign(sGr) * pow(abs(sGr), 0.55);
  sGr2 = sign(sGr2) * pow(abs(sGr2), 0.55);
  sRo = sign(sRo) * pow(abs(sRo), 0.55);

  float mow = 0.0;
  mow += sFw * (wFw + wCut * 0.5) * 0.9;
  mow += (sGr * 0.72 + sGr2 * 0.28) * wGreen;
  mow += sRo * wRough * 0.42;
  mow += sFw * wTee * 0.9;
  float stripeAmt = clamp(mow, -1.0, 1.0);

  float stripeMask = clamp(wFw + wCut * 0.5 + wGreen + wRough * 0.55 + wTee, 0.0, 1.0) * wTurf;

  /* Mowing stripes are the signature of a manicured course and they were barely
   * reading. They are not a paint effect — the bands differ because the blades
   * are leaning toward you or away from you, so the contrast depends on where
   * the sun is relative to the band. Driving the albedo term harder *and*
   * letting the view-dependent part of it grow with a low sun is what makes a
   * fairway look cut from the tee instead of like a green sheet. */
  float stripeView = 1.0 - abs(dot(normalize(vec2(V.x, V.z) + 1e-5), grainDir));
  float stripeGain = 0.175 + wGreen * 0.095 + stripeView * 0.075;
  albedo *= 1.0 + stripeAmt * stripeMask * stripeGain;

  // The collar is a distinct cut, about a metre wide, kept a shade darker than
  // the surface it rings — not a five-metre gradient.
  float collar = (1.0 - wGreen) * (1.0 - smoothstep(0.4, 1.9, dGr));
  albedo *= 1.0 - collar * 0.10;

  float smoothTurf = 1.0 - wGreen * 0.82;
  /* Mottling. Kept, but gentler than it was: at full strength the fairway
     close up read as camouflage, and real mown turf from standing height is a
     much finer, flatter texture with the stripes doing most of the work. */
  albedo *= 1.0 + ((fine - 0.5) * 0.08 * lodFine * (1.0 - wSand)
                 + (micro - 0.5) * 0.06 * lodMicro) * smoothTurf;
  albedo *= 1.0 + (fbm2r(xz * 0.30, 3) - 0.5) * 0.10 * smoothTurf;
  if (lodFine > 0.004) albedo *= 1.0 + (fbm2r(xz * 0.55, 2) - 0.5) * 0.06 * smoothTurf * lodFine;
  albedo *= 1.0 - (1.0 - smoothstep(0.0, 1.4, abs(dFw))) * 0.07;

  /* ---- bunkers ---------------------------------------------------------
   * Sand is raked in passes that follow the shape of the bunker, so the ripples
   * run parallel to its edge. The signed distance field is exactly that shape,
   * which makes a sine of that distance the right ripple for free, and it is why
   * they curve correctly around every lobe of an eight-bunker complex instead of
   * being a straight-line pattern laid over the top.
   */
  if (wSand > 0.002) {
    float wobble = fbm2r(xz * 0.22, 3);
    float rake = sin((dSa + wobble * 0.9) * 12.0) * 0.5 + 0.5;
    rake = pow(rake, 1.4);
    float rakeAmt = lodFine * wSand * (1.0 - smoothstep(1.2, 5.0, -dSa) * 0.55);
    albedo = mix(albedo, albedo * (0.86 + 0.26 * rake), rakeAmt);

    // the flashed face: sand thrown up the far wall is brighter and finer than
    // the floor it was raked off
    float flash = smoothstep(-1.6, -0.15, dSa) * wSand;
    albedo = mix(albedo, albedo * 1.16 + vec3(0.035, 0.028, 0.016), flash * 0.7);
  }

  /* The lip. Turf overhangs the cut edge and throws a hard little shadow into
   * the sand — the single strongest cue that a bunker is a hole in the ground
   * rather than a light patch painted on it. */
  float lip = (1.0 - smoothstep(0.0, 0.55, abs(dSa + 0.18)));
  albedo *= 1.0 - lip * 0.34 * step(-0.9, dSa);

  /* ---- the woodland floor ---------------------------------------------
   * Where the mown corridor runs out into the trees, grass does not simply get
   * darker: it thins, gives way to leaf litter and bare earth, and breaks up
   * into patches under the canopy. Every framing of a golf hole has this
   * boundary running down both sides of it, so a flat 16% darkening there is a
   * lot of the frame left on the table.
   */
  /* Keyed off distance outside the mown corridor as well as the mapped
     woodland. The wood polygons in the OSM data are sparse — six for the whole
     property — but the tree scatter puts trees wherever the corridor runs out,
     so that is where the ground under them has to change too. */
  float underTrees = max(wood, smoothstep(7.0, 26.0, dCo));
  float litter = underTrees * (1.0 - wFw) * (1.0 - wGreen) * (1.0 - wSand) * (1.0 - wPath);
  if (litter > 0.002) {
    // (not "patch" — that is a reserved word in GLSL ES 3.00, held for
    // tessellation, and the compiler's message about it is not obvious)
    float duff = fbm2r(xz * 0.55 + 4.1, 3);
    float fine2 = fbm2r(xz * 2.3, 2);
    // brown leaf litter, with bare soil showing through where it is thickest
    vec3 leafLitter = mix(vec3(0.196, 0.140, 0.078), vec3(0.286, 0.212, 0.116), fine2);
    vec3 soil = vec3(0.132, 0.098, 0.070) * (0.85 + 0.4 * fine2);
    vec3 floorCol = mix(leafLitter, soil, smoothstep(0.58, 0.86, duff) * 0.7);
    // shade-starved grass in between: yellower and sparser
    vec3 thin = mix(albedo, vec3(0.140, 0.156, 0.082), 0.45);
    floorCol = mix(thin, floorCol, smoothstep(0.30, 0.72, duff));
    albedo = mix(albedo, floorCol, clamp(litter * 1.35, 0.0, 0.92));
  }

  /* ---- scars: divots, pitch marks, wear -------------------------------- */
  float dent = 0.0;
  if (uScarOn > 0.5 && uDetail > 0.5){
    vec2 su = (xz - uScarRect.xy) * uScarRect.w;
    if (su.x > 0.0 && su.x < 1.0 && su.y > 0.0 && su.y < 1.0){
      vec3 s = texture(uScar, su).rgb;
      // r: divot (turf removed, soil showing)  g: pitch mark  b: foot/tyre wear
      vec3 soil = vec3(0.150, 0.105, 0.072) * (0.8 + 0.5 * micro);
      albedo = mix(albedo, soil, s.r * 0.88);
      albedo = mix(albedo, albedo * 0.80, s.g);
      albedo *= 1.0 - s.b * 0.16;
      dent = s.r * 0.55 + s.g * 0.30;
    }
  }

  /* ---- normal ---------------------------------------------------------- */
  vec3 Nb = N;
  if (lodBump > 0.004){
    float e = 0.5;
    float h0 = fbm2r(xz * 1.4, 2);
    float hx = fbm2r((xz + vec2(e,0.0)) * 1.4, 2);
    float hz = fbm2r((xz + vec2(0.0,e)) * 1.4, 2);
    /* Mown turf is close to flat at this scale: a strong bump here, under a
       low sun, came out as dark blotches across every tee and fairway. Rough
       keeps its lumps. */
    float amp = mix(mix(0.15, 0.42, wRough), 0.025, wGreen) * (1.0 - wPath) * lodBump;
    Nb = normalize(N + vec3(-(hx-h0)/e, 0.0, -(hz-h0)/e) * amp);
  }
  // blade-scale grain: only within a few metres, where a pixel is smaller than
  // a clump of grass
  if (lodBlade > 0.004){
    vec2 g;
    bladeGrain(xz, mix(9.0, 26.0, wGreen), g);
    // a green is cut to three millimetres and rolled: from standing height it
    // is velvet, not grain, and a grainy normal there sparkles under the sheen
    float amp = mix(0.36, 0.045, wGreen) * mix(1.0, 2.6, wRough) * lodBlade * wTurf;
    Nb = normalize(Nb + vec3(-g.x, 0.0, -g.y) * amp);
  }
  if (dent > 0.001){
    vec2 g; bladeGrain(xz, 40.0, g);
    Nb = normalize(Nb + vec3(-g.x, 0.0, -g.y) * dent * 1.2);
  }
  Nb = normalize(Nb + vec3(grainDir.x, 0.0, grainDir.y) * stripeAmt * stripeMask * 0.46);

  /* ---- lighting -------------------------------------------------------- */
  float ndl = dot(Nb, uSunDir);
  float wrap = 0.28;
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);

  float sh = sunVisibility(vWorld, max(ndl, 0.0), viewDist);
  sh = mix(sh, sh * 0.5 + 0.5, 0.12);

  // Two-lobe anisotropic sheen. Grass is a bundle of fibres lying along the
  // mowing direction: one tight lobe gives the specular glint you get looking
  // down a stripe, a broad one gives the general sheen of the sward.
  vec3 T = normalize(vec3(grainDir.x, 0.0, grainDir.y)
                     - Nb * dot(Nb, vec3(grainDir.x, 0.0, grainDir.y)));
  float tl = dot(T, uSunDir), tv = dot(T, V);
  float k = clamp(sqrt(max(1.0-tl*tl,0.0)) * sqrt(max(1.0-tv*tv,0.0)) - tl*tv, 0.0, 1.0);
  float sheen = pow(k, 42.0) * 0.62 * (1.0 - wGreen * 0.6) + pow(k, 9.0) * (0.20 + wGreen * 0.10);
  float sheenAmt = (wFw*0.9 + wGreen*1.30 + wTee*0.9 + wRough*0.45) * (1.0 - wSand);

  // dew: a wet sward at dawn is markedly more specular and scatters a bright
  // sheen back at a low sun
  float dew = uDew * wTurf * (1.0 - wGreen * 0.3);
  vec3 H = normalize(uSunDir + V);
  float wet = pow(max(dot(Nb, H), 0.0), 180.0) * dew * 1.9;

  float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 3.0) * clamp(0.35 - ndl*0.35, 0.0, 1.0);
  vec3 transCol = vec3(0.40, 0.60, 0.16) * trans * wTurf;

  float sandSpec = pow(max(dot(reflect(-uSunDir, Nb), V), 0.0), 5.0) * wSand * 0.045;

  float ao = vAO;
  ao *= 1.0 - wood * 0.30;
  ao *= 1.0 - smoothstep(0.0, -2.2, dSa) * 0.40;      // inside the dish
  ao *= screenAO();
  ao = clamp(ao, 0.0, 1.0);

  // ambient straight off the atmosphere: a level surface sees the whole sky,
  // a slope sees part of it plus bounce off the turf next to it
  vec3 skyUp = skyRadiance(vec3(0.0, 1.0, 0.0));
  vec3 skyHz = skyRadiance(normalize(vec3(V.x, 0.12, V.z)));
  // the deck hides part of the blue sky and replaces it with its own grey glow,
  // which is what actually fills a cloud shadow — without it, shadowed turf is
  // lit by clear-sky blue alone and reads as cold and dead
  vec3 ambient = mix(skyHz, skyUp, 0.55) * (1.0 - uCloudCover * 0.30)
               * (0.42 + 0.34 * Nb.y) * ao;
  ambient += uCloudFill * (0.45 + 0.55 * max(Nb.y, 0.0)) * ao;
  ambient += uGroundTint * 0.34 * (1.0 - Nb.y) * ao;
  ambient += uSunColor * albedo * 0.075 * (1.0 - sh) * ao;

  vec3 col = albedo * (uSunColor * diff * sh * 1.20 + ambient);
  col += uSunColor * sheen * sheenAmt * sh * 0.24;
  col += uSunColor * wet * sh;
  col += uSunColor * sandSpec * sh;
  col += transCol * uSunColor * 0.55;

  col = applyAerial(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}
`;

  /* ============================================================ trees */

  const treeVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aData;      // x: 0 trunk / 1 canopy, yz: leaf atlas uv
layout(location=3) in vec4 iA;
layout(location=4) in vec4 iB;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
out vec2 vUv;
out float vHue;
out float vIsCanopy;
out float vPhase;

uniform mat4 uViewProj;
uniform float uTimeT;
uniform float uWind;
uniform vec2 uWindDir;

void main(){
  float s = iA.w;
  float c = cos(iB.x), sn = sin(iB.x);
  vec3 p = aPos;
  p.xz *= s;
  p.y  *= s * iB.w;
  vec3 rp = vec3(c*p.x + sn*p.z, p.y, -sn*p.x + c*p.z);
  vec3 rn = vec3(c*aNormal.x + sn*aNormal.z, aNormal.y, -sn*aNormal.x + c*aNormal.z);

  // Sway along the wind, not along X. Gusts travel: the phase includes the
  // tree's position projected on the wind direction, so a squall crosses the
  // tree line instead of every tree waving in place.
  float h = max(p.y, 0.0) / max(s * iB.w * 9.0, 0.001);
  float travel = dot(iA.xz, uWindDir) * 0.014;
  float t = uTimeT * 0.9 + iB.z - travel;
  float sway = sin(t) * 0.62 + sin(t * 2.31 + 1.7) * 0.28 + sin(t * 4.7 + 0.4) * 0.10;
  float gust = 0.65 + 0.35 * sin(uTimeT * 0.31 - travel * 0.6);
  float amp = sway * h * h * uWind * gust;
  rp.xz += uWindDir * amp * 0.62;
  rp.xz += vec2(-uWindDir.y, uWindDir.x) * cos(t * 0.83 + iB.z) * h * h * uWind * 0.24;

  vWorld = iA.xyz + rp;
  vNormal = rn;
  vLocal = p / max(s, 0.001);
  vUv = aData.yz;
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
in vec2 vUv;
in float vHue;
in float vIsCanopy;
in float vPhase;
out vec4 frag;

uniform float uAlphaCut;
uniform float uSeason;      // 0 high summer .. 1 early autumn
uniform sampler2D uLeaf;    // R brightness, G yellowing, B thickness, A coverage

${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AOTEX}
${AERIAL}

void main(){
  float viewDist = distance(uCamPos, vWorld);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);

  if (vIsCanopy > 0.5){
    vec4 leaf = texture(uLeaf, vUv);

    /* Alpha cutoff loosens with distance.
     *
     * Alpha-tested foliage sparkles once a leaf is smaller than a pixel: the
     * test flips on and off between frames and the canopy boils. Letting the
     * threshold fall with distance closes the crown into a solid mass instead,
     * which is also what a tree a hundred metres away actually looks like. */
    float cut = mix(uAlphaCut, 0.12, smoothstep(45.0, 170.0, viewDist));
    if (leaf.a < cut) discard;

    float n = vnoise3(vWorld * 1.15 + vPhase) * 0.62 + vnoise3(vWorld * 3.4 + vPhase) * 0.38;
    float n2 = leaf.r;

    /* The card is lit by the lobe it sits on, not by its own flat normal — a
     * quad lit by its own normal reads as the sheet it is. A small tilt from the
     * leaf texture's thickness channel gives each cluster its own bend without
     * breaking the volume the crown is describing. */
    vec3 jn = normalize(N + (vec3(leaf.r, leaf.b, leaf.g) - 0.5) * 0.85);
    N = normalize(mix(jn, N, smoothstep(50.0, 170.0, viewDist)));

    float shade = 0.50 + 0.72 * leaf.r;

    /* Species colour. The original ran one hue ramp from dark to light green
       and tinted the top 14% of trees brown. A parkland tree line is a mix of
       distinctly different greens — that variance, not the individual tree, is
       what makes a wood read as a wood. */
    vec3 base;
    float sp = fract(vHue * 3.37);
    if (vHue < 0.34)      base = mix(vec3(0.088,0.152,0.052), vec3(0.150,0.226,0.076), sp); // oak, deep
    else if (vHue < 0.62) base = mix(vec3(0.132,0.212,0.070), vec3(0.196,0.290,0.104), sp); // elm, mid
    else if (vHue < 0.86) base = mix(vec3(0.170,0.268,0.092), vec3(0.244,0.348,0.126), sp); // maple, bright
    else                  base = mix(vec3(0.070,0.128,0.078), vec3(0.104,0.166,0.098), sp); // spruce, blue-green
    base = mix(base, base * vec3(1.35, 1.06, 0.62), uSeason * smoothstep(0.55, 1.0, vHue));
    // leaves that have turned, straight out of the texture's yellowing channel
    base = mix(base, base * vec3(1.55, 1.12, 0.48), leaf.g * (0.35 + uSeason * 0.65));
    base = mix(base, base * vec3(1.10, 1.04, 0.94), n * 0.35);

    // vertical light gradient through the crown, plus deeper shade inside
    base *= 0.70 + 0.60 * smoothstep(-0.4, 0.9, vLocal.y * 0.55 + 0.35);
    base *= shade;

    float ndl = dot(N, uSunDir);
    float diff = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);
    float sh = sunVisibility(vWorld, max(ndl, 0.0), viewDist);
    float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 2.0) * 0.95;
    trans *= 0.35 + 0.65 * clamp(1.0 - abs(ndl), 0.0, 1.0);
    vec3 transCol = vec3(0.46, 0.74, 0.20) * trans * (0.30 + 0.70 * sh);

    // deep shade toward the middle of the crown, where very little sky reaches,
    // plus the cluster's own thickness: a card buried in leaves sees less sky
    float inner = clamp(1.0 - length(vLocal.xz) * 1.05, 0.0, 1.0);
    float ao = mix(1.0, 0.40, inner * inner) * (0.62 + 0.38 * n)
             * (1.0 - leaf.b * 0.30) * screenAO();

    vec3 skyUp = skyRadiance(vec3(0.0,1.0,0.0));
    vec3 skyHz = skyRadiance(normalize(vec3(V.x, 0.10, V.z)));
    vec3 ambient = mix(skyHz, skyUp, 0.62) * (1.0 - uCloudCover * 0.30)
                 * (0.40 + 0.30 * N.y) * ao;
    ambient += uCloudFill * (0.45 + 0.55 * max(N.y, 0.0)) * ao;
    ambient += uGroundTint * 0.42 * clamp(-N.y, 0.0, 1.0) * ao;

    vec3 col = base * (uSunColor * diff * sh * 1.20 + ambient) + transCol * uSunColor * 0.60;
    float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 22.0) * 0.17 * sh;
    col += uSunColor * spec * (0.4 + 0.6 * n);
    col = applyAerial(col, vWorld, -V);
    frag = vec4(col * uExposure, 1.0);
  } else {
    // Bark. Almost always in the crown's own shade, so a low albedo plus a low
    // ambient term reads as a black stick rather than as wood.
    float g = vnoise3(vWorld * vec3(2.6, 0.5, 2.6));
    vec3 base = mix(vec3(0.196,0.156,0.124), vec3(0.310,0.256,0.206), g);
    base *= 0.84 + 0.32 * vnoise3(vWorld * vec3(9.0, 1.4, 9.0));
    // vertical fissures, which is most of what reads as bark at any distance
    base *= 0.86 + 0.28 * vnoise3(vWorld * vec3(26.0, 1.1, 26.0));
    float ndl = dot(N, uSunDir);
    float diff = clamp((ndl + 0.25) / 1.25, 0.0, 1.0);
    float sh = sunVisibility(vWorld, max(ndl,0.0), viewDist);
    float ao = screenAO();
    vec3 ambient = skyRadiance(vec3(0.0,1.0,0.0)) * 0.34 * ao
                 + uCloudFill * 0.42 * ao + uGroundTint * 0.34 * ao;
    vec3 col = base * (uSunColor * diff * sh + ambient);
    col = applyAerial(col, vWorld, -V);
    frag = vec4(col * uExposure, 1.0);
  }
}`;

  /* ============================================================ impostors */

  const impostorVert = `
layout(location=0) in vec2 aCorner;
layout(location=3) in vec4 iA;
layout(location=4) in vec4 iB;
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
uniform float uSeason;
uniform sampler2D uLeaf;
${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AERIAL}
void main(){
  vec2 p = vUv - vec2(0.5, 0.44);
  p.y *= 0.88;
  float ang = atan(p.y, p.x);
  float r = length(p);
  float lobes = 0.335 + 0.055 * sin(ang * 5.0 + vPhase * 6.0)
                      + 0.040 * sin(ang * 9.0 - vPhase * 3.0)
                      + 0.028 * sin(ang * 15.0 + vPhase);
  float n = vnoise(vUv * 11.0 + vPhase * 20.0);
  // the same leaf clusters the near trees are built from, so a tree does not
  // change species as it crosses the impostor boundary
  vec4 leaf = texture(uLeaf, fract(vUv * 1.7 + vPhase * 0.31) * 0.5
                            + vec2(mod(floor(vPhase * 3.0), 2.0) * 0.5, 0.0));
  float n2 = leaf.r;
  float edge = lobes * (0.86 + 0.24 * n);
  // erode the rim with the leaf coverage so the outline is clumped, not oval
  if (r > edge * (0.80 + 0.20 * leaf.a)) discard;

  vec3 V = normalize(uCamPos - vWorld);
  float k = clamp(1.0 - pow(r / max(edge, 0.001), 2.0), 0.0, 1.0);
  vec3 N = normalize(vRight * (p.x / max(edge, 0.001))
                   + vUpV  * (p.y / max(edge, 0.001))
                   + vFace * (0.55 + 0.45 * sqrt(k)));

  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);

  vec3 base;
  float sp = fract(vHue * 3.37);
  if (vHue < 0.34)      base = mix(vec3(0.088,0.152,0.052), vec3(0.150,0.226,0.076), sp);
  else if (vHue < 0.62) base = mix(vec3(0.132,0.212,0.070), vec3(0.196,0.290,0.104), sp);
  else if (vHue < 0.86) base = mix(vec3(0.170,0.268,0.092), vec3(0.244,0.348,0.126), sp);
  else                  base = mix(vec3(0.070,0.128,0.078), vec3(0.104,0.166,0.098), sp);
  base = mix(base, base * vec3(1.35, 1.06, 0.62), uSeason * smoothstep(0.55, 1.0, vHue));
  base *= 0.70 + 0.60 * smoothstep(-0.4, 0.9, (p.y / max(edge,0.001)) * 0.55 + 0.35);
  base *= 0.80 + 0.30 * n2;

  // impostors are far away, so weather is all the shadow detail they need
  float sh = cloudShadow(vWorld);
  float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 2.0) * 0.85;
  vec3 skyUp = skyRadiance(vec3(0.0,1.0,0.0));
  vec3 skyHz = skyRadiance(normalize(vec3(V.x, 0.10, V.z)));
  vec3 ambient = mix(skyHz, skyUp, 0.62) * (1.0 - uCloudCover * 0.30) * (0.38 + 0.24 * N.y)
               + uCloudFill * (0.45 + 0.55 * max(N.y, 0.0));
  vec3 col = base * (uSunColor * diff * sh * 1.20 + ambient)
           + vec3(0.46,0.74,0.20) * trans * uSunColor * 0.42;
  col += uSunColor * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 18.0) * 0.22 * sh;
  col = applyAerial(col, vWorld, -V);
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
uniform sampler2D uFieldA;
uniform vec4 uFieldRect;
${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AERIAL}

void main(){
  vec2 xz = vWorld.xz;
  float dWa = texture(uFieldA, (xz - uFieldRect.xy) * uFieldRect.w).w;
  if (dWa > 0.0) discard;

  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);

  vec2 w1 = xz * 0.85 + vec2(uTime * 0.11, uTime * 0.07);
  vec2 w2 = xz * 1.9  - vec2(uTime * 0.09, uTime * 0.14);
  float e = 0.16;
  float h  = fbm2(w1, 3) * 0.6 + fbm2(w2, 3) * 0.4;
  float hx = fbm2(w1 + vec2(e,0), 3) * 0.6 + fbm2(w2 + vec2(e,0), 3) * 0.4;
  float hz = fbm2(w1 + vec2(0,e), 3) * 0.6 + fbm2(w2 + vec2(0,e), 3) * 0.4;
  float amp = 0.11 * (1.0 - smoothstep(30.0, 260.0, viewDist));
  vec3 N = normalize(vec3(-(hx - h) / e * amp, 1.0, -(hz - h) / e * amp));

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.86 + 0.02;
  vec3 refl = skyRadiance(normalize(R));
  vec4 rc = clouds(normalize(R));
  refl = mix(refl, rc.rgb, rc.a * 0.9);
  refl += E0 * beamTransmittance(uSunDir.y)
        * pow(max(dot(normalize(R), uSunDir), 0.0), 420.0) * 5.0 * cloudShadow(vWorld);

  float f = 0.024 + 0.976 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

  float depth = clamp(-dWa / 9.0, 0.0, 1.0);
  vec3 body = mix(vec3(0.108, 0.176, 0.132), vec3(0.028, 0.076, 0.070), depth);
  body *= (skyRadiance(vec3(0.0,1.0,0.0)) + uSunColor * 0.35 * max(uSunDir.y,0.0)) * 1.5;

  vec3 col = mix(body, refl, clamp(f, 0.0, 1.0));

  float edge = 1.0 - smoothstep(0.0, 1.5, -dWa);
  col = mix(col, col * 0.72 + vec3(0.16,0.17,0.14) * 0.6, edge * 0.5);

  float sh = sunVisibility(vWorld, 1.0, viewDist);
  col *= mix(0.72, 1.0, sh);
  col = applyAerial(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================ props */

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
uniform float uEmissive;
uniform float uRough;
${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AOTEX}
${AERIAL}
void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);
  float ndl = dot(N, uSunDir);
  float diff = clamp(ndl, 0.0, 1.0);
  float sh = sunVisibility(vWorld, max(ndl,0.0), viewDist);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N,H),0.0), mix(220.0, 14.0, uRough)) * mix(0.55, 0.06, uRough);
  float ao = screenAO();
  vec3 ambient = skyRadiance(vec3(0.0,1.0,0.0)) * (1.0 - uCloudCover * 0.30)
               * (0.30 + 0.24*N.y) * ao
               + uCloudFill * (0.45 + 0.55 * max(N.y, 0.0)) * ao
               + uGroundTint * 0.30 * (1.0 - N.y) * ao;
  vec3 col = vColor * (uSunColor * diff * sh * 1.25 + ambient);
  col += uSunColor * spec * sh;
  col += vColor * uEmissive;
  col = applyAerial(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ============================================================= ball
   *
   * The ball gets its own shader because it is the only object the player ever
   * looks at from six inches away, and through the generic prop path it is a
   * smooth white blob — the one thing a golf ball is not. Two things fix it:
   * dimples, and a cover that behaves like urethane rather than plaster.
   *
   * The dimples are a hex lattice laid on a cube projection of the object-space
   * normal. A real ball packs its dimples icosahedrally; a cube seam is a
   * visible cheat at a metre and invisible at ball scale, which is the only
   * scale anybody sees it at. What matters is that they perturb the normal, so
   * the highlight breaks into the stipple that reads as "golf ball" even when
   * the ball is twenty pixels across.
   */
  const ballVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vObj;
uniform mat4 uViewProj;
uniform mat4 uModel;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vObj = normalize(aNormal);
  gl_Position = uViewProj * w;
}`;

  const ballFrag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vObj;
out vec4 frag;
uniform float uDimples;      // lattice frequency; 0 disables
uniform vec3 uBallTint;
${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AOTEX}
${AERIAL}

/* Nearest centre of a hex lattice: two interleaved rectangular grids, take
   whichever centre is closer. Returns the offset from that centre. */
vec2 hexOffset(vec2 p){
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 h = s * 0.5;
  vec2 a = mod(p, s) - h;
  vec2 b = mod(p - h, s) - h;
  return dot(a, a) < dot(b, b) ? a : b;
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);

  /* --- dimples ---------------------------------------------------------
     Fade the lattice out with distance rather than letting it alias: past a
     few metres a dimple is well under a pixel, and what survives sampling is
     noise, not a ball. */
  float dimAmt = uDimples > 0.0 ? (1.0 - smoothstep(2.5, 9.0, viewDist)) : 0.0;
  float pit = 0.0;
  if (dimAmt > 0.001){
    vec3 an = abs(vObj);
    vec2 uv = vec2(0.0);
    vec3 tu = vec3(1.0, 0.0, 0.0);
    vec3 tv = vec3(0.0, 1.0, 0.0);
    if (an.x >= an.y && an.x >= an.z){ uv = vObj.zy / an.x; tu = vec3(0.0,0.0,1.0); tv = vec3(0.0,1.0,0.0); }
    else if (an.y >= an.z)           { uv = vObj.xz / an.y; tu = vec3(1.0,0.0,0.0); tv = vec3(0.0,0.0,1.0); }
    else                             { uv = vObj.xy / an.z; tu = vec3(1.0,0.0,0.0); tv = vec3(0.0,1.0,0.0); }
    vec2 gv = hexOffset(uv * uDimples);
    float d = length(gv);
    const float R = 0.42;
    // 1 in the pit, 0 on the land between dimples
    pit = 1.0 - smoothstep(R * 0.72, R, d);
    // a spherical cap slopes linearly out of its centre, so the tilt is the
    // offset itself; it points back toward the centre because the pit is concave
    N = normalize(N - (tu * gv.x + tv * gv.y) * (2.1 * pit * dimAmt));
  }

  float ndl = dot(N, uSunDir);
  float diff = clamp(ndl, 0.0, 1.0);
  float sh = sunVisibility(vWorld, max(ndl, 0.0), viewDist);
  float ao = screenAO() * (1.0 - 0.14 * pit * dimAmt);

  /* Urethane: a broad sheen off the cover plus the tight kick off the clear
     coat. One lobe alone reads as either chalk or a marble. */
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  float spec = pow(nh, 90.0) * 0.30 + pow(nh, 300.0) * 1.10;

  vec3 ambient = skyRadiance(vec3(0.0,1.0,0.0)) * (1.0 - uCloudCover * 0.30)
               * (0.34 + 0.26 * N.y) * ao
               + uCloudFill * (0.45 + 0.55 * max(N.y, 0.0)) * ao
               + uGroundTint * 0.34 * (1.0 - N.y) * ao;

  vec3 col = uBallTint * (uSunColor * diff * sh * 1.30 + ambient);
  col += uSunColor * spec * sh;
  // the cover is slightly translucent, which shows as a rim that never goes
  // fully dark on the shadow side
  col += uBallTint * ambient * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * 0.55;

  col = applyAerial(col, vWorld, -V);
  frag = vec4(col * uExposure, 1.0);
}`;

  /* ====================================================== contact shadow
   *
   * The shadow cascade covers a hundred metres in 2048 texels, so a 43 mm ball
   * is a fraction of one texel and casts nothing at all. Without the dark patch
   * where it meets the turf the ball reads as hovering — the single strongest
   * cue that an object is sitting on a surface, missing. This is that patch:
   * one multiplied disc that widens and softens as the ball climbs, which is
   * also a free read on how high the shot is.
   */
  const blobVert = `
layout(location=0) in vec2 aXZ;
out vec2 vXZ;
uniform mat4 uViewProj;
uniform vec3 uBlobPos;      // ground point under the ball
uniform float uBlobR;
void main(){
  vXZ = aXZ;
  vec3 w = uBlobPos + vec3(aXZ.x, 0.0, aXZ.y) * uBlobR;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

  const blobFrag = `
precision highp float;
in vec2 vXZ;
out vec4 frag;
uniform float uBlobDark;    // 0 = invisible, 1 = full
uniform float uBlobSoft;    // 0 = crisp rim, 1 = wide gradient
void main(){
  float d = length(vXZ);
  float a = 1.0 - smoothstep(mix(0.55, 0.0, uBlobSoft), 1.0, d);
  a *= a;
  frag = vec4(vec3(1.0 - a * uBlobDark), 1.0);
}`;

  /* ============================================================ grass */

  const grassVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in float aT;
layout(location=3) in vec4 iA;         // x,y,z, height
layout(location=4) in vec4 iB;         // rotY, bendX, bendZ, hue
out vec3 vWorld;
out vec3 vNormal;
out float vT;
out float vHue;
out float vAO;
out float vShort;
uniform mat4 uViewProj;
uniform float uTimeG;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec3 uCamPosG;
void main(){
  float c = cos(iB.x), s = sin(iB.x);
  vec3 p = aPos;
  p.y *= iA.w;
  /* Blade width scales with the height of cut. Left at a constant width, a
     2 cm fairway blade is as wide as it is tall and reads as a dark fleck of
     debris rather than grass; a knee-high fescue blade wants the full width. */
  p.xz *= clamp(iA.w * 11.0, 0.22, 1.5);

  float t = aT * aT;
  // Gusts travel across the turf along the wind vector rather than every blade
  // bending on the same clock.
  float travel = dot(iA.xz, uWindDir) * 0.34;
  float ph = iA.x * 0.7 + iA.z * 0.9;
  float gust = sin(uTimeG * 1.6 + ph - travel) * 0.5
             + sin(uTimeG * 3.1 + ph * 1.7 - travel * 1.6) * 0.28;
  vec2 bend = vec2(iB.y, iB.z) + uWindDir * gust * uWind * 0.55;
  p.x += bend.x * t * iA.w;
  p.z += bend.y * t * iA.w;

  vec3 rp = vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z);
  vWorld = iA.xyz + rp;
  vNormal = normalize(vec3(-s * 0.45, 1.0, -c * 0.45));
  vT = aT;
  vHue = iB.w;
  // Self-shading down in the sward. Only deep grass has a sward to be shaded
  // by: a mown blade is lit along its whole length, and darkening its base is
  // what makes short grass render as grit.
  vShort = 1.0 - clamp(iA.w * 7.0, 0.0, 1.0);
  vAO = mix(0.30 + 0.70 * aT, 0.92, vShort);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

  const grassFrag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vT;
in float vHue;
in float vAO;
in float vShort;
out vec4 frag;
uniform float uGrassFade;
${NOISE}
${ATMOS}
${CLOUDS}
${SHADOW}
${AERIAL}
void main(){
  vec3 V = normalize(uCamPos - vWorld);
  float viewDist = distance(uCamPos, vWorld);
  vec3 N = normalize(vNormal);

  // Mown turf is a brighter, bluer green than fescue; the hue channel already
  // carries which surface this blade grew on. Keep the mown end of the ramp on
  // the same green as the ground shader's fairway — a blade warmer than the
  // turf it grew out of reads as straw scattered over grass.
  vec3 base = mix(vec3(0.150,0.246,0.086), vec3(0.232,0.268,0.128), vHue);
  base = mix(vec3(0.196,0.330,0.112), base, clamp(vHue * 2.2, 0.0, 1.0));
  base = mix(mix(base * 0.72, base * 1.20, vT), base * 1.06, vShort);

  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + 0.42) / 1.42, 0.0, 1.0);
  float sh = sunVisibility(vWorld, max(ndl,0.0), viewDist);
  sh = mix(sh, 1.0, 0.22);
  float trans = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 2.2) * vT;
  vec3 ambient = skyRadiance(vec3(0.0,1.0,0.0)) * (1.0 - uCloudCover * 0.30)
               * (0.30 + 0.24 * vT) * vAO
               + uCloudFill * 0.75 * vAO + uGroundTint * 0.34 * vAO;
  vec3 col = base * (uSunColor * diff * sh * 1.20 + ambient);
  col += vec3(0.46,0.70,0.20) * trans * uSunColor * 0.7;
  col = applyAerial(col, vWorld, -V);
  float a = 1.0 - smoothstep(uGrassFade * 0.62, uGrassFade, viewDist);
  if (a < 0.02) discard;
  frag = vec4(col * uExposure, a);
}`;

  /* ============================================================ shadow pass */

  const shadowVert = `
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uModel;
void main(){ gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;

  const shadowTreeVert = depthTreeVert;

  /* Leaves have to cast dappled shadows, which means the shadow and depth passes
     need the same alpha test the colour pass uses. A solid quad casting a solid
     shadow is worse than no card foliage at all — it puts hard rectangles on the
     fairway. */
  const leafDepthVert = `
layout(location=0) in vec3 aPos;
layout(location=2) in vec4 aData;
layout(location=3) in vec4 iA;
layout(location=4) in vec4 iB;
out vec2 vUv;
out float vIsCanopy;
uniform mat4 uViewProj;
void main(){
  float s = iA.w;
  float c = cos(iB.x), sn = sin(iB.x);
  vec3 p = aPos; p.xz *= s; p.y *= s * iB.w;
  vec3 rp = vec3(c*p.x + sn*p.z, p.y, -sn*p.x + c*p.z);
  vUv = aData.yz;
  vIsCanopy = aData.x;
  gl_Position = uViewProj * vec4(iA.xyz + rp, 1.0);
}`;

  const leafDepthFrag = `
precision highp float;
in vec2 vUv;
in float vIsCanopy;
uniform sampler2D uLeaf;
uniform float uAlphaCut;
void main(){
  if (vIsCanopy > 0.5 && texture(uLeaf, vUv).a < uAlphaCut) discard;
}`;

  const shadowFrag = `
precision highp float;
void main(){}`;

  /* ============================================================ tracer */

  const tracerVert = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aSide;
layout(location=2) in vec3 aDir;
out float vAcross;
out float vAlong;
out vec3 vWorld;
uniform mat4 uViewProj;
uniform vec3 uCamPosT;
uniform float uWidth;
void main(){
  vec3 toCam = normalize(uCamPosT - aPos);
  vec3 side = normalize(cross(normalize(aDir), toCam));
  // constant apparent width: a ribbon that thins with distance disappears at
  // the far end of a 300-yard drive
  float w = uWidth * mix(0.35, 1.0, smoothstep(0.0, 0.10, aSide.y))
          * (0.5 + distance(uCamPosT, aPos) * 0.010);
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
uniform float uExposureT;
void main(){
  if (vAlong > uProgress) discard;
  float core = 1.0 - smoothstep(0.0, 1.0, abs(vAcross));
  float a = pow(core, 1.6);
  float head = smoothstep(uProgress - 0.055, uProgress, vAlong);
  float tail = smoothstep(0.0, 0.42, vAlong / max(uProgress, 0.001));
  a *= mix(0.22, 1.0, tail);
  vec3 col = mix(uColor, vec3(1.0), head * 0.85 + pow(core, 6.0) * 0.5);
  frag = vec4(col * (1.0 + head * 2.4) * uExposureT, a * (0.55 + head * 0.45));
}`;

  /* ============================================================ post */

  const fsqVert = `
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  /* Circle of confusion from real camera geometry, packed into the alpha of a
   * half-resolution colour buffer so the gather passes get it for free. */
  const cocFrag = `
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTex;
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCamPosD;
uniform float uFocus;        // metres
uniform float uFocal;        // mm
uniform float uAperture;     // f-number
uniform float uMaxCoC;       // pixels
uniform float uViewH;        // viewport height, pixels
void main(){
  float d = texture(uDepth, vUv).r;
  vec4 c = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 P = c.xyz / c.w;
  float z = d >= 0.99999 ? 1.0e6 : distance(P, uCamPosD);

  // thin lens: blur diameter on the sensor, in millimetres
  float f = uFocal, S1 = max(uFocus, 0.15);
  float cocMm = abs(f * f * (z - S1)) / (uAperture * max(z, 0.05) * max(S1 - f * 0.001, 0.001)) * 0.001;
  // 24 mm sensor height maps to the full viewport
  float cocPx = cocMm / 24.0 * uViewH;
  frag = vec4(texture(uTex, vUv).rgb, clamp(cocPx, 0.0, uMaxCoC) / uMaxCoC);
}`;

  const dofFrag = `
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uDir;          // texel step * max radius
uniform float uMaxCoC;
void main(){
  vec4 c0 = texture(uTex, vUv);
  float r0 = c0.a;
  vec3 sum = c0.rgb;
  float wsum = 1.0;
  const int N = 8;
  for (int i = 1; i <= N; i++){
    float t = float(i) / float(N);
    for (int s = -1; s <= 1; s += 2){
      vec2 uv = vUv + uDir * t * float(s);
      vec4 c = texture(uTex, uv);
      // A sample only contributes if its own blur circle reaches this pixel.
      // Without that test a sharp foreground smears over a blurred background.
      float reach = max(c.a, r0);
      float w = step(t, reach + 0.001) * (0.35 + 0.65 * c.a);
      sum += c.rgb * w;
      wsum += w;
    }
  }
  frag = vec4(sum / wsum, r0);
}`;

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

  /* Crepuscular rays: radially blur the bright pass toward the sun's screen
   * position, gated by the depth buffer so only sky pixels emit. Cheap, and it
   * is what a low sun through a tree line actually looks like. */
  const godrayFrag = `
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex;
uniform sampler2D uDepth;
uniform vec2 uSunUv;
uniform float uDecay;
uniform float uDensity;
void main(){
  vec2 dir = (uSunUv - vUv) * uDensity;
  const int N = 20;
  dir /= float(N);
  vec2 uv = vUv;
  float w = 1.0;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < N; i++){
    float d = texture(uDepth, uv).r;
    float open = d >= 0.99995 ? 1.0 : 0.0;     // sky only
    sum += texture(uTex, uv).rgb * w * open;
    wsum += w;
    w *= uDecay;
    uv += dir;
  }
  frag = vec4(sum / max(wsum, 0.001), 1.0);
}`;

  const compositeFrag = `
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex;
uniform sampler2D uDof;
uniform sampler2D uBloom;
uniform sampler2D uShafts;
uniform vec2 uTexel;
uniform float uDofAmt;
uniform float uBloomAmt;
uniform float uShaftAmt;
uniform float uVignette;
uniform float uSaturation;
uniform float uPunch;
uniform vec3 uWhiteBalance;
uniform float uAgx;
uniform float uGrain;
uniform float uFrameC;
${TONEMAP}

/**
 * Scene-referred linear in, display-referred (transfer-encoded) out.
 *
 * AgX's sigmoid already lands in display space, so its result must NOT be
 * gamma-encoded again afterwards — doing so is what turns a correctly exposed
 * frame into a pale, milky one. ACES is the opposite: its output is
 * display-linear and does need encoding. Both branches return the same space so
 * the FXAA and grade below them do not have to care which ran.
 */
vec3 tone(vec3 c){
  c *= uWhiteBalance;
  if (uAgx > 0.5) return clamp(agxOut(agxLook(agx(c), uSaturation, uPunch)), 0.0, 1.0);
  vec3 a = aces(c);
  float l = dot(a, vec3(0.2126, 0.7152, 0.0722));
  a = pow(max(mix(vec3(l), a, uSaturation), 0.0), vec3(uPunch));
  return pow(clamp(a, 0.0, 1.0), vec3(1.0 / 2.2));
}

/* Sharp image, with the half-resolution defocused copy blended in by however
   large this pixel's blur circle is. Compositing rather than replacing keeps
   the in-focus band at full resolution. */
vec3 fetch(vec2 uv){
  vec3 sharp = texture(uTex, uv).rgb;
  if (uDofAmt < 0.5) return sharp;
  vec4 d = texture(uDof, uv);
  return mix(sharp, d.rgb, clamp(d.a * 2.4, 0.0, 1.0));
}

void main(){
  vec3 hdr = fetch(vUv);
  hdr += texture(uBloom, vUv).rgb * uBloomAmt;
  hdr += texture(uShafts, vUv).rgb * uShaftAmt;

  vec3 c = tone(hdr);

  // FXAA on the display-referred image
  float lM = dot(c, vec3(0.299,0.587,0.114));
  float lN = dot(tone(fetch(vUv + vec2(0.0, -uTexel.y))), vec3(0.299,0.587,0.114));
  float lS = dot(tone(fetch(vUv + vec2(0.0,  uTexel.y))), vec3(0.299,0.587,0.114));
  float lW = dot(tone(fetch(vUv + vec2(-uTexel.x, 0.0))), vec3(0.299,0.587,0.114));
  float lE = dot(tone(fetch(vUv + vec2( uTexel.x, 0.0))), vec3(0.299,0.587,0.114));
  float lMin = min(lM, min(min(lN,lS), min(lW,lE)));
  float lMax = max(lM, max(max(lN,lS), max(lW,lE)));
  if (lMax - lMin > max(0.028, lMax * 0.135)){
    vec2 dir = vec2(-(lN - lS), (lE - lW));
    float rl = 1.0 / (max(abs(dir.x), abs(dir.y)) + 1e-4);
    dir = clamp(dir * rl, -3.0, 3.0) * uTexel;
    vec3 a = 0.5 * (tone(fetch(vUv + dir * (1.0/3.0 - 0.5))) + tone(fetch(vUv + dir * (2.0/3.0 - 0.5))));
    vec3 b = a * 0.5 + 0.25 * (tone(fetch(vUv - dir * 0.5)) + tone(fetch(vUv + dir * 0.5)));
    float lb = dot(b, vec3(0.299,0.587,0.114));
    c = (lb < lMin || lb > lMax) ? a : b;
  }

  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * uVignette;
  c *= vig;

  float g = fract(sin(dot(vUv + uFrameC * 0.0173, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * uGrain;

  frag = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

  root.SHP = {
    skyVert, skyFrag,
    depthVert, depthTreeVert, depthFrag,
    ssaoFrag, ssaoBlurFrag,
    terrainVert, terrainFrag,
    treeVert, treeFrag,
    impostorVert, impostorFrag,
    waterVert, waterFrag,
    propVert, propFrag,
    ballVert, ballFrag,
    blobVert, blobFrag,
    grassVert, grassFrag,
    shadowVert, shadowTreeVert, shadowFrag,
    leafDepthVert, leafDepthFrag,
    tracerVert, tracerFrag,
    fsqVert, cocFrag, dofFrag, brightFrag, blurFrag, godrayFrag, compositeFrag
  };
})(window);
