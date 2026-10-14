// Screen → world: the pointer's ray through the camera room.html actually drew with (pose = {p, q, fov}), the 16:9 canvas shown "cover".
const THREE = window.THREE;
export function rayFromClient(canvas, pose, clientX, clientY) {
  const r = canvas.getBoundingClientRect(), A = 16 / 9, B = r.width / r.height;
  let nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -(((clientY - r.top) / r.height) * 2 - 1);
  if (B > A) ny *= A / B; else nx *= B / A; // object-fit: cover crops the long side
  const th = Math.tan((pose.fov * Math.PI) / 360);
  return { o: pose.p.clone(), d: new THREE.Vector3(nx * th * A, ny * th, -1).normalize().applyQuaternion(pose.q) };
}
/** where the ray meets the floor (y = 0), or null if it points up / too far */
export function floorPoint(canvas, pose, x, y, maxDist = 8) {
  const { o, d } = rayFromClient(canvas, pose, x, y); if (d.y > -0.02) return null;
  const t = -o.y / d.y; if (t > maxDist) return null; return { x: o.x + d.x * t, z: o.z + d.z * t };
}
