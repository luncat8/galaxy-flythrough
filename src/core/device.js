// src/core/device.js
// WebGPU adapter/device + canvas context.
//
// Limits are negotiated instead of demanded: a device request that asks for a
// limit above the adapter's maximum fails the whole init. We ask for what the
// renderer wants, clamped to what the adapter actually reports, and hand the
// effective limits back so the caller can size its buffers.

'use strict';

const DESIRED_LIMITS = {
	maxStorageBufferBindingSize: 256 * 1024 * 1024,
	maxBufferSize: 256 * 1024 * 1024,
	maxComputeWorkgroupsPerDimension: 65535,
	maxStorageBuffersPerShaderStage: 8,
};

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

	const format = navigator.gpu.getPreferredCanvasFormat();
	const context = canvas.getContext('webgpu');
	if (!context) {
		throw new Error('canvas.getContext("webgpu") returned null');
	}
	context.configure({ device, format, alphaMode: 'premultiplied' });

	return { device, context, format, adapter, limits };
}

const Device = {
	initDevice, DESIRED_LIMITS, clampLimits,
	// Set by the host to receive device-lost notifications.
	onLost: null,
};
if (typeof module !== 'undefined') module.exports = Device;
if (typeof window !== 'undefined') window.Device = Device;
