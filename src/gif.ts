import { Throttler } from './throttler';
import { EventEmitter } from 'eventemitter3';

type Image =
  | HTMLImageElement
  | HTMLCanvasElement
  | CanvasRenderingContext2D
  | ImageData;
interface GifConfig {
  workerScript: string;
  workers: number;
  repeat: number;
  background: string;
  quality: number;
  width: number;
  height: number;
  transparent: string | null;
  debug: boolean;
  useTransferFrame: boolean;
}
const defaultGifConfig: GifConfig = {
  workerScript: 'gif.worker.js',
  workers: 2,
  repeat: 0, // repeat forever, -1 = repeat once
  background: '#fff',
  quality: 10, // pixel sample interval, lower is better
  width: null, // size derermined from first frame if possible
  height: null,
  transparent: null,
  debug: false,
  useTransferFrame: false,
};

interface FrameConfig {
  delay: number;
  copy: boolean;
  applyCropOptimization: boolean;
  transparencyDifferenceThreshold: number;
  applyTransparencyOptimization: boolean;
  dispose: number;
  isLastFrame: boolean;
  transparent: string | null;
}

const defaultFrameConfig: FrameConfig = {
  delay: 500,
  copy: false,
  applyCropOptimization: false,
  transparencyDifferenceThreshold: 1,
  applyTransparencyOptimization: false,
  dispose: -1,
  isLastFrame: false,
  transparent: null,
};

interface Frame extends FrameConfig {
  data?: Uint8ClampedArray;
  context?: CanvasRenderingContext2D;
  image?: HTMLImageElement | HTMLCanvasElement;
}

interface GifTask {
  index: number;
  last: boolean;
  delay: number;
  transparent: string;
  width: number;
  height: number;
  quality: number;
  repeat: number;
  canTransfer: boolean;
  data: Uint8ClampedArray;
  previousFrameData: Uint8ClampedArray | null;
}

export class GIF extends EventEmitter {
  private freeWorkers: Worker[];
  private activeWorkers: Worker[];
  private gifConfig: GifConfig;
  private queueSize: number;
  private throttler: Throttler;
  private nextFrame: number;
  private imageParts: (null | Frame)[];
  private previousFrame: null | Frame;
  private _canvas: HTMLCanvasElement | null;

  constructor(options: GifConfig) {
    super();
    this.freeWorkers = [];
    this.activeWorkers = [];
    this.gifConfig = { ...defaultGifConfig, ...options };
    // This can be more but we keep queue size fixed here so
    // that we dont have to manage task queue.
    this.queueSize = Math.max(this.gifConfig.workers, 1);
    this.spawnWorkers();
    this.throttler = new Throttler(this.gifConfig.workers);
    this.nextFrame = 0;
    this.imageParts = [];
    this.previousFrame = null;
  }

  private spawnWorkers() {
    for (let i = 0; i < this.gifConfig.workers; i++) {
      const worker = new Worker(this.gifConfig.workerScript);
      const messageHandler = (event) => {
        const index = this.activeWorkers.indexOf(worker);
        if (index !== -1) {
          this.activeWorkers.splice(index, 1);
        }

        this.freeWorkers.push(worker);
        this.frameFinished(event.data);
      };

      worker.onmessage = messageHandler;
      this.freeWorkers.push(worker);
    }
  }

  async addFrame(image: Image, options: FrameConfig) {
    const frameConfig: FrameConfig = {
      ...defaultFrameConfig,
      ...options,
      transparent: this.gifConfig.transparent,
    };
    await new Promise((resolve) => setTimeout(resolve, 100));

    const frame = this.getFrameData(image, frameConfig);

    await this.throttler.wait();
    this.render(frame, this.previousFrame, options.isLastFrame ?? false);

    if (options.applyTransparencyOptimization) {
      this.previousFrame = frame;
    }

    this.emit('progress', 0);
  }

  render(frame: Frame, previousFrame: Frame, isLastFrame = false): void {
    if (!this.gifConfig.width || !this.gifConfig.height) {
      throw new Error('Width and height must be set prior to rendering');
    }

    if (this.freeWorkers.length === 0) {
      throw new Error('No workers available');
    }

    this.imageParts.push(null);
    const worker = this.freeWorkers.shift();
    const task = this.getTask(
      this.nextFrame++,
      frame,
      previousFrame,
      isLastFrame,
    );
    this.activeWorkers.push(worker);
    if (this.gifConfig.useTransferFrame && task.previousFrameData) {
      worker.postMessage(task, [task.previousFrameData.buffer]);
    } else {
      worker.postMessage(task);
    }
  }

  abort() {
    for (let i = 0; i < this.freeWorkers.length; i++) {
      this.freeWorkers[i].terminate();
    }
    for (let i = 0; i < this.activeWorkers.length; i++) {
      this.activeWorkers[i].terminate();
    }
    this.emit('abort');
  }

  getTask(
    index: number,
    frame: Frame,
    previousFrame: Frame,
    isLastFrame: boolean,
  ): GifTask {
    return {
      index: index,
      last: isLastFrame,
      delay: frame.delay,
      transparent: frame.transparent,
      width: this.gifConfig.width,
      height: this.gifConfig.height,
      quality: this.gifConfig.quality,
      repeat: this.gifConfig.repeat,
      canTransfer: true,
      data: this.getFrameDataForTask(frame),
      previousFrameData: previousFrame
        ? this.getFrameDataForTask(previousFrame)
        : null,
    };
  }

  getContextData(ctx: CanvasRenderingContext2D): Uint8ClampedArray {
    return ctx.getImageData(0, 0, this.gifConfig.width, this.gifConfig.height)
      .data;
  }

  getFrameDataForTask(frame: Frame): Uint8ClampedArray {
    if (frame.data) {
      return frame.data;
    } else if (frame.context) {
      return this.getContextData(frame.context);
    } else if (frame.image) {
      return this.getImageData(frame.image);
    } else {
      throw new Error('Invalid frame');
    }
  }

  frameFinished(frame): void {
    if (this.imageParts[frame.index] !== null) {
      return;
    }

    this.imageParts[frame.index] = frame;
    this.throttler.notify();
    this.emit('progress');
  }

  // async flush() {
  //   await this.throttler.ensureEmpty();
  //   let len = 0;
  //   for (const frameIndex in this.imageParts) {
  //     var frame = this.imageParts[frameIndex];
  //     len += (frame.data.length - 1) * frame.pageSize + frame.cursor;
  //   }
  //   len += frame.pageSize - frame.cursor;

  //   const data = new Uint8Array(len);
  //   let offset = 0;
  //   for (const frameIndex in this.imageParts) {
  //     const frame = this.imageParts[frameIndex];
  //     for (const i in frame.data) {
  //       const page = frame.data[i];
  //       data.set(page, offset);
  //       if (i == frame.data.length - 1) {
  //         offset += frame.cursor;
  //       } else {
  //         offset += frame.pageSize;
  //       }
  //     }
  //   }

  //   const image = new Blob([data], { type: 'image/gif' });
  //   this.emit('finished', image, data);
  //   return image;
  // }

  getFrameData(image: Image, frameConfig: FrameConfig): Frame {
    const frame = frameConfig as Frame;
    if (typeof ImageData !== 'undefined' && image instanceof ImageData) {
      frame.data = image.data;
    } else if (
      typeof CanvasRenderingContext2D !== 'undefined' &&
      image instanceof CanvasRenderingContext2D
    ) {
      if (frameConfig.copy) {
        frame.data = this.getContextData(image);
      } else {
        frame.context = image;
      }
    } else if (
      (image instanceof HTMLImageElement ||
        image instanceof HTMLCanvasElement) &&
      image.childNodes
    ) {
      if (frameConfig.copy) {
        frame.data = this.getImageData(image);
      } else {
        frame.image = image;
      }
    } else {
      throw new Error('Invalid image');
    }
    return frame;
  }

  getImageData(image: HTMLCanvasElement | HTMLImageElement): Uint8ClampedArray {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = this.gifConfig.width;
      this._canvas.height = this.gifConfig.height;
    }

    const ctx = this._canvas.getContext('2d');
    ctx.fillStyle = this.gifConfig.background;
    ctx.fillRect(0, 0, this.gifConfig.width, this.gifConfig.height);
    ctx.drawImage(image, 0, 0);

    return this.getContextData(ctx);
  }
}
