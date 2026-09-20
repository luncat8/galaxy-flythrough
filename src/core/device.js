// src/core/device.js
// WebGPU adapter/device + canvas context.
//
// Limits are negotiated instead of demanded: a device request that asks for a
// limit above the adapter's maximum fails the whole init. We ask for what the
// renderer wants, clamped to what the adapter actually reports, and hand the
// effective limits back so the caller can size its buffers.
//
// HDR canvas: where the adapter and the OS support it, the swapchain is
// rgba16float with toneMapping:{mode:'extended'} and colorSpace:'srgb', so the
// canvas is a real HDR display surface and values >1.0 reach the monitor
// (Chrome 129+, requires an HDR-capable display). On non-HDR setups the
// configure() call throws, and we fall back to the SDR preferred format and
// the renderer's ACES tonemap pass.

'use strict';

const DESIRED_LIMITS = {
        maxStorageBufferBindingSize: 256 * 1024 * 1024,
        maxBufferSize: 256 * 1024 * 1024,
        maxComputeWorkgroupsPerDimension: 65535,
        maxStorageBuffersPerShaderStage: 8,
};

const HDR_FORMAT = 'rgba16float';

function clampLimits(adapterLimits) {
        const limits = {};
        for (const name of Object.keys(DESIRED_LIMITS)) {
                const supported = adapterLimits[name];
                limits[name] = typeof supported === 'number'
                        ? Math.min(DESIRED_LIMITS[name], supported)
                        : DESIRED_LIMITS[name];
        }
        return limits;
}

// Try the HDR canvas configuration. Chrome 129+ accepts format: rgba16float
// with toneMapping: 'extended' on HDR-capable displays; older builds or other
// browsers throw on the configure() call. Returns true on success.
function tryConfigureHdr(device, context) {
        try {
                context.configure({
                        device,
                        format: HDR_FORMAT,
                        usage: GPUTextureUsage.RENDER_ATTACHMENT,
                        colorSpace: 'srgb',
                        toneMapping: { mode: 'extended' },
                        alphaMode: 'opaque',
                });
                return true;
        } catch (err) {
                // Some browsers reject the configuration asynchronously by
                // firing device.lost; we trust the synchronous throw that
                // covers every known non-supporting browser.
                return false;
        }
}

async function initDevice(canvas) {
        if (!navigator.gpu) {
                throw new Error('WebGPU is not available in this browser. Use Chrome/Edge 113+, Firefox 141+ or Safari 26+.');
        }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
                || await navigator.gpu.requestAdapter();
        if (!adapter) {
                throw new Error('No suitable GPU adapter found (WebGPU may be disabled by the browser or the GPU driver).');
        }

        const limits = clampLimits(adapter.limits);
        const device = await adapter.requestDevice({ requiredLimits: limits });

        // A lost device means every later queue.submit() is a no-op, so surface it.
        device.lost.then((info) => {
                console.error(`WebGPU device lost: ${info.reason} — ${info.message}`);
                if (Device.onLost) Device.onLost(info);
        });

        const context = canvas.getContext('webgpu');
        if (!context) {
                throw new Error('canvas.getContext("webgpu") returned null');
        }

        // HDR swapchain when the browser + OS + display support it; otherwise
        // fall back to the SDR preferred format and let the renderer tonemap.
        let hdr = false;
        let format = navigator.gpu.getPreferredCanvasFormat();
        try {
                hdr = tryConfigureHdr(device, context);
        } catch (err) {
                hdr = false;
        }
        if (hdr) {
                format = HDR_FORMAT;
        } else {
                context.configure({ device, format, alphaMode: 'premultiplied' });
        }

        return { device, context, format, adapter, limits, hdr };
}

const Device = {
        initDevice, DESIRED_LIMITS, clampLimits, HDR_FORMAT,
        // Set by the host to receive device-lost notifications.
        onLost: null,
};
if (typeof module !== 'undefined') module.exports = Device;
if (typeof window !== 'undefined') window.Device = Device;
