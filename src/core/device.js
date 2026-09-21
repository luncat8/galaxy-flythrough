// src/core/device.js
// WebGPU adapter/device + canvas context.
//
// Limits are negotiated instead of demanded: a device request that asks for a
// limit above the adapter's maximum fails the whole init. We ask for what the
// renderer wants, clamped to what the adapter actually reports, and hand the
// effective limits back so the caller can size its buffers.
//
// Rendering model: the renderer ALWAYS renders sprites additively into an
// rgba16float HDR intermediate and then runs a tone-map pass that writes the
// swapchain. There is no "direct" star path; on HDR-capable displays the
// tonemap pass outputs linear values that can exceed 1.0, which WebGPU's
// toneMapping:'extended' mode maps to the monitor's HDR headroom. On SDR
// displays the tonemap clamps to [0,1] and the canvas' colorSpace:'srgb'
// applies the linear→sRGB transfer. This way the white-point / saturation /
// exposure controls are live on every output path — no bypass.

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

// Attempt to configure the canvas as an HDR swapchain (rgba16float + extended
// tone mapping). Returns { ok, hdr }: ok=true means the canvas was configured
// for HDR output. Requires an HDR-capable display AND opt-in, because on
// recent Chrome rgba16float+extended is accepted even on SDR displays, which
// would otherwise break color grading.
function tryConfigureHdr(device, context) {
	const forceSdr = window.location.search.includes('sdr=1')
		|| window.FORCE_SDR === true;
	if (forceSdr) return { ok:false, hdr:false };
	const optIn = window.location.search.includes('hdr=1')
		|| window.USE_HDR === true
		|| (window.matchMedia && window.matchMedia('(dynamic-range: high)').matches);
	if (!optIn) return { ok:false, hdr:false };
	try {
		context.configure({
			device,
			format: HDR_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT,
			colorSpace: 'srgb',
			toneMapping: { mode: 'extended' },
			alphaMode: 'opaque',
		});
		return { ok:true, hdr:true };
	} catch (err) {
		return { ok:false, hdr:false };
	}
}

// SDR (non-HDR) canvas: we render linear RGB and the canvas handles the
// linear→sRGB encode because colorSpace:'srgb' is set.
function configureSdr(device, context, format) {
	context.configure({
		device,
		format,
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
		colorSpace: 'srgb',
		toneMapping: { mode: 'standard' },
		alphaMode: 'premultiplied',
	});
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

	device.lost.then((info) => {
		console.error(`WebGPU device lost: ${info.reason} — ${info.message}`);
		if (Device.onLost) Device.onLost(info);
	});

	const context = canvas.getContext('webgpu');
	if (!context) {
		throw new Error('canvas.getContext("webgpu") returned null');
	}

	const preferred = navigator.gpu.getPreferredCanvasFormat();
	let format = preferred;
	let hdr = false;
	const hdrAttempt = tryConfigureHdr(device, context);
	if (hdrAttempt.ok) {
		hdr = true;
		format = HDR_FORMAT;
	} else {
		configureSdr(device, context, format);
	}

	return { device, context, format, adapter, limits, hdr };
}

const Device = {
	initDevice, DESIRED_LIMITS, clampLimits, HDR_FORMAT,
	onLost: null,
};
if (typeof module !== 'undefined') module.exports = Device;
if (typeof window !== 'undefined') window.Device = Device;
