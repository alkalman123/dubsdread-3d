/* =============================================================================
   CRUX — lightweight interactive 3D viewer for product STLs.
   Vendored Three.js (js/vendor/), no CDN dependency, no build step.
   ========================================================================== */
import * as THREE from './vendor/three.module.min.js';
import { STLLoader } from './vendor/STLLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const loader = new STLLoader();
const geometryCache = new Map();

function loadGeometry(stlUrl) {
  if (geometryCache.has(stlUrl)) return Promise.resolve(geometryCache.get(stlUrl));
  return new Promise((resolve, reject) => {
    loader.load(
      stlUrl,
      (geometry) => {
        geometry.center();
        geometry.computeVertexNormals();
        geometryCache.set(stlUrl, geometry);
        resolve(geometry);
      },
      undefined,
      reject
    );
  });
}

export function mountModelViewer(container, { stlUrl, color = '#63707c', onReady, onError }) {
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 400;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, width / height, 1, 5000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-1, 1.6, 1.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe8d8, 0.6);
  fill.position.set(1.2, 0.4, -0.8);
  scene.add(fill);

  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.05 });
  let mesh = null;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2.2;
  controls.minDistance = 1;
  controls.maxDistance = 1;
  controls.enablePan = false;

  ['pointerdown', 'wheel', 'touchstart'].forEach((evt) => {
    renderer.domElement.addEventListener(evt, () => { controls.autoRotate = false; }, { passive: true });
  });

  let raf = null;
  function animate() {
    raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  loadGeometry(stlUrl)
    .then((geometry) => {
      mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2; // STL is Z-up (as printed); Three.js is Y-up
      scene.add(mesh);

      geometry.computeBoundingSphere();
      const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 60;
      const dist = radius * 3.1;
      camera.position.set(dist * 0.6, dist * 0.5, dist * 0.75);
      camera.near = dist / 100;
      camera.far = dist * 20;
      camera.updateProjectionMatrix();
      controls.minDistance = dist * 0.4;
      controls.maxDistance = dist * 2.2;
      controls.target.set(0, 0, 0);
      controls.update();

      animate();
      if (onReady) onReady();
    })
    .catch((err) => {
      if (onError) onError(err);
    });

  function handleResize() {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  const ro = new ResizeObserver(handleResize);
  ro.observe(container);

  return {
    setColor(hex) {
      material.color.set(hex);
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    },
  };
}
