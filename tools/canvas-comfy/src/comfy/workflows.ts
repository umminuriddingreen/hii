export function txt2img(prompt: string, neg = '', w = 1024, h = 1024, ckpt?: string) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt || 'sd_xl_base_1.0.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 32), steps: 25, cfg: 7,
        sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'canvas', images: ['6', 0] } },
  }
}

export function img2img(prompt: string, imgName: string, denoise = 0.6, neg = '', ckpt?: string) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt || 'sd_xl_base_1.0.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['1', 1] } },
    '8': { class_type: 'LoadImage', inputs: { image: imgName } },
    '9': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['1', 2] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 32), steps: 25, cfg: 7,
        sampler_name: 'euler_ancestral', scheduler: 'normal', denoise,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['9', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'canvas', images: ['6', 0] } },
  }
}
