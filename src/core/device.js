// src/core/device.js
// WebGPU device + canvas context init.

'use strict';

async function initDevice(canvas) {
	if (!navigator.gpu) {
		throw new Error('WebGPU not supported in this browser');
	}
	const adapter = await navigator.gpu.requestAdapter({
		powerPreference: 'high-performance',
	});
	if (!adapter) {
		throw new Error('No suitable GPU adapter found');
	}
	const device = await adapter.requestDevice({
		requiredFeatures: [],
		requiredLimits: {
			maxStorageBufferBindingSize: 256 * 1024 * 1024,
			maxBufferSize: 256 * 1024 * 1024,
			maxComputeWorkgroupsPerDimension: 65535,
		},
	});

	const format = navigator.gpu.getPreferredCanvasFormat();
	const context = canvas.getContext('webgpu');
	context.configure({
		device,
		format,
		alphaMode: 'premultiplied',
	});

	return { device, context, format, adapter };
}

if (typeof module !== 'undefined') {
	module.exports = { initDevice };
}
if (typeof window !== 'undefined') {
	window.Device = { initDevice };
}
