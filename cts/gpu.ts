// A WebGPU implementation for the CTS command-line runner (--gpu-provider) that validates the
// shaders with the analyzer and accepts everything else.

import { lint } from "../src/index.ts";
import type { Diagnostic } from "../src/syntax/diagnostic.ts";
import { standardExtensions } from "../src/semantic/check.ts";
import { validatePipeline } from "../src/semantic/pipeline.ts";
import { analyze } from "../src/index.ts";

const features = [
    "depth-clip-control",
    "depth32float-stencil8",
    "texture-compression-bc",
    "texture-compression-bc-sliced-3d",
    "texture-compression-etc2",
    "texture-compression-astc",
    "texture-compression-astc-sliced-3d",
    "timestamp-query",
    "indirect-first-instance",
    "shader-f16",
    "rg11b10ufloat-renderable",
    "bgra8unorm-storage",
    "float32-filterable",
    "float32-blendable",
    "clip-distances",
    "dual-source-blending",
    "subgroups",
    "core-features-and-limits",
    "texture-formats-tier1",
    "texture-formats-tier2",
    "primitive-index",
    "subgroup-size-control",
    "atomic-vec2u-min-max",
];

const limits: Record<string, number> = {
    maxTextureDimension1D: 8192,
    maxTextureDimension2D: 8192,
    maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 256,
    maxBindGroups: 4,
    maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000,
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 4,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16,
    maxStorageBuffersInFragmentStage: 8,
    maxStorageBuffersInVertexStage: 8,
    maxStorageBuffersPerShaderStage: 8,
    maxStorageTexturesInFragmentStage: 4,
    maxStorageTexturesInVertexStage: 4,
    maxStorageTexturesPerShaderStage: 4,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 134217728,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    maxVertexBuffers: 8,
    maxBufferSize: 268435456,
    maxVertexAttributes: 16,
    maxVertexBufferArrayStride: 2048,
    maxInterStageShaderVariables: 16,
    maxColorAttachments: 8,
    maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 16384,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535,
    maxImmediateSize: 64,
};

const extensionOfFeature: Record<string, string> = {
    "shader-f16": "f16",
    "clip-distances": "clip_distances",
    "dual-source-blending": "dual_source_blending",
    subgroups: "subgroups",
    "primitive-index": "primitive_index",
    "subgroup-size-control": "subgroup_size_control",
    "atomic-vec2u-min-max": "atomic_vec2u_min_max",
};

const languageFeatures = [
    "readonly_and_readwrite_storage_textures",
    "packed_4x8_integer_dot_product",
    "unrestricted_pointer_parameters",
    "pointer_composite_access",
    "uniform_buffer_standard_layout",
    "subgroup_id",
    "subgroup_uniformity",
    "texture_and_sampler_let",
    "texture_formats_tier1",
    "linear_indexing",
    "immediate_address_space",
    "buffer_view",
    "swizzle_assignment",
];

const adapterInfo = {
    vendor: "wgsl-linter",
    architecture: "",
    device: "",
    description: "",
    subgroupMinSize: 4,
    subgroupMaxSize: 128,
    isFallbackAdapter: false,
};

class GPUError {
    constructor(readonly message: string) {}
}
class GPUValidationError extends GPUError {}
class GPUOutOfMemoryError extends GPUError {}
class GPUInternalError extends GPUError {}

const globals = globalThis as Record<string, unknown>;
globals.GPUError = GPUError;
globals.GPUValidationError = GPUValidationError;
globals.GPUOutOfMemoryError = GPUOutOfMemoryError;
globals.GPUInternalError = GPUInternalError;
globals.GPUBufferUsage = {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
};
globals.GPUTextureUsage = {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
};
globals.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globals.GPUMapMode = { READ: 1, WRITE: 2 };
globals.GPUColorWrite = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };

class ShaderModule {
    readonly messages: Diagnostic[];
    readonly valid: boolean;
    constructor(
        readonly code: string,
        readonly extensions: Set<string>,
    ) {
        this.messages = lint(code, { extensions });
        this.valid = !this.messages.some(m => m.severity === "error");
    }
    getCompilationInfo(): Promise<unknown> {
        const lines = this.code.slice(0);
        const messages = this.messages.map(m => {
            const before = lines.slice(0, m.start);
            const lineNum = before.split("\n").length;
            const linePos = m.start - before.lastIndexOf("\n");
            return {
                message: m.message,
                type: m.severity,
                lineNum,
                linePos,
                offset: m.start,
                length: m.end - m.start,
            };
        });
        return Promise.resolve({ messages });
    }
}

class Device {
    readonly features: Set<string>;
    readonly limits = limits;
    readonly adapterInfo = adapterInfo;
    readonly queue = {
        submit() {},
        writeBuffer() {},
        writeTexture() {},
        onSubmittedWorkDone: () => Promise.resolve(),
    };
    readonly lost: Promise<unknown>;
    private resolveLost!: (info: unknown) => void;
    private readonly scopes: { filter: string; error: GPUError | null }[] = [];
    private readonly extensions = new Set<string>();

    constructor(descriptor?: { requiredFeatures?: Iterable<string> }) {
        this.features = new Set(descriptor?.requiredFeatures ?? []);
        for (const feature of this.features) {
            const extension = extensionOfFeature[feature];
            if (extension && standardExtensions.has(extension)) this.extensions.add(extension);
            if (feature === "subgroup-size-control") this.extensions.add("subgroups");
        }
        this.lost = new Promise(resolve => (this.resolveLost = resolve));
    }

    destroy(): void {
        this.resolveLost({ reason: "destroyed", message: "" });
    }

    pushErrorScope(filter: string): void {
        this.scopes.push({ filter, error: null });
    }

    popErrorScope(): Promise<GPUError | null> {
        const scope = this.scopes.pop();
        if (!scope) return Promise.reject(new DOMException("no error scope", "OperationError"));
        return Promise.resolve(scope.error);
    }

    private validationError(message: string): void {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const scope = this.scopes[i]!;
            if (scope.filter !== "validation") continue;
            scope.error ??= new GPUValidationError(message);
            return;
        }
    }

    createShaderModule(descriptor: { code: string }): ShaderModule {
        const module = new ShaderModule(descriptor.code, this.extensions);
        if (!module.valid)
            this.validationError(module.messages.find(m => m.severity === "error")!.message);
        return module;
    }

    createComputePipeline(descriptor: {
        compute: { module: ShaderModule; entryPoint?: string; constants?: Record<string, number> };
    }): object {
        const { module, entryPoint, constants } = descriptor.compute;
        if (!module.valid) {
            this.validationError("invalid shader module");
            return {};
        }
        const error = validatePipeline(analyze(module.code, { extensions: module.extensions }), {
            stage: "compute",
            entryPoint,
            constants: constants ?? {},
            limits,
        });
        if (error) this.validationError(error);
        return { getBindGroupLayout: () => ({}) };
    }

    createComputePipelineAsync(
        descriptor: Parameters<Device["createComputePipeline"]>[0],
    ): Promise<object> {
        return Promise.resolve(this.createComputePipeline(descriptor));
    }

    createRenderPipeline(descriptor: {
        vertex: { module: ShaderModule; entryPoint?: string; constants?: Record<string, number> };
        fragment?: {
            module: ShaderModule;
            entryPoint?: string;
            constants?: Record<string, number>;
        };
    }): object {
        for (const [stage, state] of [
            ["vertex", descriptor.vertex],
            ["fragment", descriptor.fragment],
        ] as const) {
            if (!state) continue;
            if (!state.module.valid) {
                this.validationError("invalid shader module");
                continue;
            }
            const error = validatePipeline(
                analyze(state.module.code, { extensions: state.module.extensions }),
                {
                    stage,
                    entryPoint: state.entryPoint,
                    constants: state.constants ?? {},
                    limits,
                },
            );
            if (error) this.validationError(error);
        }
        return { getBindGroupLayout: () => ({}) };
    }

    createRenderPipelineAsync(
        descriptor: Parameters<Device["createRenderPipeline"]>[0],
    ): Promise<object> {
        return Promise.resolve(this.createRenderPipeline(descriptor));
    }

    createBuffer(descriptor: { size: number }): object {
        return {
            size: descriptor.size,
            destroy() {},
            mapAsync: () => Promise.resolve(),
            getMappedRange: () => new ArrayBuffer(descriptor.size),
            unmap() {},
        };
    }

    createTexture(descriptor: object): object {
        return { ...descriptor, destroy() {}, createView: () => ({}) };
    }

    createSampler(): object {
        return {};
    }

    createBindGroupLayout(): object {
        return {};
    }

    createPipelineLayout(): object {
        return {};
    }

    createBindGroup(): object {
        return {};
    }

    createQuerySet(): object {
        return { destroy() {} };
    }

    createCommandEncoder(): object {
        const pass = new Proxy({}, { get: () => () => {} });
        return {
            beginComputePass: () => pass,
            beginRenderPass: () => pass,
            copyBufferToBuffer() {},
            copyBufferToTexture() {},
            copyTextureToBuffer() {},
            copyTextureToTexture() {},
            clearBuffer() {},
            finish: () => ({}),
        };
    }

    addEventListener(): void {}
    removeEventListener(): void {}
}

class Adapter {
    readonly features = new Set(features);
    readonly limits = limits;
    readonly info = adapterInfo;
    readonly isFallbackAdapter = false;
    readonly featureLevel = "core";

    requestDevice(descriptor?: { requiredFeatures?: Iterable<string> }): Promise<Device> {
        return Promise.resolve(new Device(descriptor));
    }
}

/** Creates the GPU for the CTS runner. */
export function create(): object {
    return {
        wgslLanguageFeatures: new Set(languageFeatures),
        requestAdapter: () => Promise.resolve(new Adapter()),
        getPreferredCanvasFormat: () => "bgra8unorm",
    };
}
