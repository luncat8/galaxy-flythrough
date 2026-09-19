// src/core/camera.js
// 6-DOF momentum camera.
// Position in kpc. WASD translates, mouse drag rotates, scroll wheel
// adjusts speed. Velocity persists with mild damping (0.92/frame) for
// smooth fly-through feel. Speed is logarithmic across many orders of
// magnitude (pc/s to kpc/s).
//
// No allocations in the hot path: reuses preallocated typed arrays
// for viewProj and cameraPos uniforms.

'use strict';

const TAU = Math.PI * 2;
const DAMPING = 0.92;
const MIN_SPEED_KPC_S = 0.0001;    // 0.1 pc/s
const MAX_SPEED_KPC_S = 100.0;     // 100 kpc/s
const DEFAULT_SPEED_KPC_S = 0.010; // 10 pc/s

function createCamera() {
        // Position (kpc). Sun at origin.
        const position = new Float64Array([0, 0, 0.005]);
        // Velocity (kpc/s)
        const velocity = new Float64Array([0, 0, 0]);
        // Orientation: yaw (around Z), pitch (around camera right)
        let yaw = 0;
        let pitch = 0;
        // Speed multiplier (log scale)
        let speedMult = 1.0;

        // Preallocated output buffers (avoid per-frame alloc)
        const viewProj = new Float32Array(16);
        const cameraPos = new Float32Array(4);
        const forward = new Float32Array(3);
        const right = new Float32Array(3);
        const up = new Float32Array(3);

        // Reusable scratch
        const _m = new Float32Array(16);
        const _v = new Float32Array(3);

        function updateForward() {
                // Forward = direction camera looks (from yaw, pitch)
                const cy = Math.cos(yaw);
                const sy = Math.sin(yaw);
                const cp = Math.cos(pitch);
                const sp = Math.sin(pitch);
                forward[0] = cy * cp;
                forward[1] = sy * cp;
                forward[2] = sp;
                // Right = normalise(cross(forward, worldUp)) where worldUp = (0,0,1).
                // cross(forward, (0,0,1)) = (forward.y, -forward.x, 0); normalize by cp.
                // When pitch = ±pi/2 the cross product degenerates; clamp cp to a small positive.
                const cpClamped = Math.max(1e-4, Math.abs(cp));
                right[0] = sy * cp / cpClamped;
                right[1] = -cy * cp / cpClamped;
                right[2] = 0;
                // Up = cross(right, forward)
                up[0] = -cy * sp;
                up[1] = -sy * sp;
                up[2] = cp;
        }
        updateForward();

        function step(dt, input) {
                // Speed scaling: scroll wheel adjusts log-speed
                if (input.scrollDelta !== 0) {
                        speedMult *= Math.exp(-input.scrollDelta * 0.001);
                        speedMult = Math.max(0.1, Math.min(10.0, speedMult));
                        input.scrollDelta = 0;
                }
                // Apply rotation from mouse drag
                if (input.mouseDown) {
                        yaw -= input.mouseDx * 0.005;
                        pitch -= input.mouseDy * 0.005;
                        pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
                        updateForward();
                        input.mouseDx = 0;
                        input.mouseDy = 0;
                }

                // Build desired velocity from input
                let vx = 0, vy = 0, vz = 0;
                if (input.keys.w) { vx += forward[0]; vy += forward[1]; vz += forward[2]; }
                if (input.keys.s) { vx -= forward[0]; vy -= forward[1]; vz -= forward[2]; }
                if (input.keys.d) { vx += right[0]; vy += right[1]; vz += right[2]; }
                if (input.keys.a) { vx -= right[0]; vy -= right[1]; vz -= right[2]; }
                if (input.keys.e) { vz += 1; }
                if (input.keys.q) { vz -= 1; }

                // Normalize and scale by speed
                const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz);
                if (vlen > 0.001) {
                        const speed = DEFAULT_SPEED_KPC_S * speedMult;
                        vx = vx / vlen * speed;
                        vy = vy / vlen * speed;
                        vz = vz / vlen * speed;
                }
                // Apply to velocity with damping
                velocity[0] = velocity[0] * DAMPING + vx * (1 - DAMPING);
                velocity[1] = velocity[1] * DAMPING + vy * (1 - DAMPING);
                velocity[2] = velocity[2] * DAMPING + vz * (1 - DAMPING);

                // Update position
                position[0] += velocity[0] * dt;
                position[1] += velocity[1] * dt;
                position[2] += velocity[2] * dt;
        }

        // Build view-projection matrix (row-major, ready for WGSL mat4x4<f32>)
        // Compute view matrix: lookAt(position, position + forward, up)
        function buildViewProj(aspect, fov, near, far) {
                // View matrix (right-handed lookAt)
                // Eye = position
                // Target = position + forward
                // Up = world up (0,0,1)
                const ex = position[0], ey = position[1], ez = position[2];
                // World up = Z axis
                const ux = 0, uy = 0, uz = 1;
                // forward = target - eye
                const fx = forward[0], fy = forward[1], fz = forward[2];
                // s = forward x up
                const sx = fy * uz - fz * uy;
                const sy_ = fz * ux - fx * uz;
                const sz = fx * uy - fy * ux;
                const slen = Math.sqrt(sx * sx + sy_ * sy_ + sz * sz);
                const sxN = sx / slen, syN = sy_ / slen, szN = sz / slen;
                // u' = s x forward
                const uxN = syN * fz - szN * fy;
                const uyN = szN * fx - sxN * fz;
                const uzN = sxN * fy - syN * fx;

                // View matrix (column-major for WGSL)
                const view = [
                        sxN, uxN, -fx, 0,
                        syN, uyN, -fy, 0,
                        szN, uzN, -fz, 0,
                        -(sxN * ex + syN * ey + szN * ez),
                        -(uxN * ex + uyN * ey + uzN * ez),
                        (fx * ex + fy * ey + fz * ez),
                        1,
                ];

                // Projection matrix (perspective, column-major)
                const f = 1 / Math.tan(fov / 2);
                const rangeInv = 1 / (near - far);
                const proj = [
                        f / aspect, 0, 0, 0,
                        0, f, 0, 0,
                        0, 0, (near + far) * rangeInv, -1,
                        0, 0, 2 * near * far * rangeInv, 0,
                ];

                // viewProj = proj * view
                for (let col = 0; col < 4; col++) {
                        for (let row = 0; row < 4; row++) {
                                let sum = 0;
                                for (let k = 0; k < 4; k++) {
                                        sum += proj[k * 4 + row] * view[col * 4 + k];
                                }
                                viewProj[col * 4 + row] = sum;
                        }
                }

                // Camera position uniform
                cameraPos[0] = position[0];
                cameraPos[1] = position[1];
                cameraPos[2] = position[2];
                cameraPos[3] = 0;

                return viewProj;
        }

        function getState() {
                return {
                        position: Array.from(position),
                        velocity: Array.from(velocity),
                        yaw, pitch, speedMult,
                };
        }

        function setState(state) {
                position[0] = state.position[0];
                position[1] = state.position[1];
                position[2] = state.position[2];
                velocity[0] = state.velocity[0];
                velocity[1] = state.velocity[1];
                velocity[2] = state.velocity[2];
                yaw = state.yaw;
                pitch = state.pitch;
                speedMult = state.speedMult;
                updateForward();
        }

        return {
                step,
                buildViewProj,
                getState,
                setState,
                // Exposed for renderer
                get viewProj() { return viewProj; },
                get cameraPos() { return cameraPos; },
                get forward() { return forward; },
                get right() { return right; },
                get up() { return up; },
        };
}

if (typeof module !== 'undefined') {
        module.exports = { createCamera, DEFAULT_SPEED_KPC_S, MIN_SPEED_KPC_S, MAX_SPEED_KPC_S };
}
if (typeof window !== 'undefined') {
        window.Camera = { createCamera };
}
