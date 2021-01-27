import type { GeoTIFFImage, RasterOptions } from 'geotiff';
import type { TypedArray } from 'zarr';
import { getImageSize, isInterleaved, SIGNAL_ABORTED } from '../utils';

import type {
  PixelSource,
  PixelSourceSelection,
  PixelSourceMeta,
  SupportedDtype,
  Labels,
  RasterSelection,
  TileSelection,
  LayerData
} from '../../types';

class TiffPixelSource<S extends string[]> implements PixelSource<S> {
  private _indexer: (sel: PixelSourceSelection<S>) => Promise<GeoTIFFImage>;

  constructor(
    indexer: (sel: PixelSourceSelection<S>) => Promise<GeoTIFFImage>,
    public dtype: SupportedDtype,
    public tileSize: number,
    public shape: number[],
    public labels: Labels<S>,
    public meta?: PixelSourceMeta
  ) {
    this._indexer = indexer;
  }

  async getRaster({ selection }: RasterSelection<S>) {
    const image = await this._indexer(selection);
    return this._readRasters(image);
  }

  async getVolume(
    { selection }: RasterSelection<S> | TileSelection<S>,
    // eslint-disable-next-line no-unused-vars
    updateProgress = (progress: number) => {},
    downsampleDepth = 1
  ) {
    const { shape, labels, dtype } = this;
    let progress = 0;
    const { height, width } = getImageSize(this);
    const depth = shape[labels.indexOf('z')];
    const depthDownsampled = Math.floor(depth / downsampleDepth);
    const rasterSize = height * width;
    const name = `${dtype}Array`;
    const { BYTES_PER_ELEMENT } = globalThis[name] as TypedArray;
    const setMethodString = `set${dtype}` as
      | 'setUint8'
      | 'setUint16'
      | 'setUint32'
      | 'setFloat32';
    const view = new DataView(
      new ArrayBuffer(rasterSize * depthDownsampled * BYTES_PER_ELEMENT)
    );
    await Promise.all(
      new Array(depthDownsampled).fill(0).map(async (_, z) => {
        const depthSelection = {
          ...selection,
          z: z * downsampleDepth
        };
        const image = await this._indexer(depthSelection);
        const { data } = await this._readRasters(image);
        progress += 0.5;
        updateProgress(progress / depthDownsampled);
        let r = 0;
        while (r < rasterSize) {
          view[setMethodString](
            BYTES_PER_ELEMENT * (depthDownsampled - z - 1) * rasterSize +
              BYTES_PER_ELEMENT * r,
            Math.max(0, data[r]),
            true // always little endian from geotiff
          );
          r += 1;
        }
        progress += 0.5;
        updateProgress(progress / depthDownsampled);
      })
    );
    return {
      data: new globalThis[name](view.buffer),
      height,
      width,
      depth: depthDownsampled
    } as LayerData;
  }

  async getTile({ x, y, selection, signal }: TileSelection<S>) {
    const { height, width } = this._getTileExtent(x, y);
    const x0 = x * this.tileSize;
    const y0 = y * this.tileSize;
    const window = [x0, y0, x0 + width, y0 + height];

    const image = await this._indexer(selection);
    return this._readRasters(image, { window, width, height, signal });
  }

  private async _readRasters(image: GeoTIFFImage, props?: RasterOptions) {
    const interleave = isInterleaved(this.shape);
    const raster = await image.readRasters({ interleave, ...props });

    if (props?.signal?.aborted) {
      throw SIGNAL_ABORTED;
    }

    /*
     * geotiff.js returns objects with different structure
     * depending on `interleave`. It's weird, but this seems to work.
     */
    let data = (interleave ? raster : raster[0]) as TypedArray;

    /*
     * GeoTiff.js returns Uint32Array when the tiff has 32 significant bits,
     * even if the image is Float32. The underlying ArrayBuffer is correct, but
     * we need to take a different TypeArray view of the buffer.
     */
    if (this.dtype === 'Float32') {
      data = new Float32Array(data.buffer);
    }

    // geotiff.js returns the correct TypedArray but need to cast to Uint for viv.
    if (data?.constructor.name.startsWith('Int')) {
      const suffix = data.constructor.name.slice(1); // nt8Array | nt16Array | nt32Array
      const name = `Ui${suffix}` as
        | 'Uint8Array'
        | 'Uint16Array'
        | 'Uint32Array';
      data = new globalThis[name](data);
    }

    return {
      data: data,
      width: raster.width,
      height: raster.height
    } as LayerData;
  }

  /*
   * Computes tile size given x, y coord.
   */
  private _getTileExtent(x: number, y: number) {
    const { height: zoomLevelHeight, width: zoomLevelWidth } = getImageSize(
      this
    );
    let height = this.tileSize;
    let width = this.tileSize;
    const maxXTileCoord = Math.floor(zoomLevelWidth / this.tileSize);
    const maxYTileCoord = Math.floor(zoomLevelHeight / this.tileSize);
    if (x === maxXTileCoord) {
      width = zoomLevelWidth % this.tileSize;
    }
    if (y === maxYTileCoord) {
      height = zoomLevelHeight % this.tileSize;
    }
    return { height, width };
  }

  onTileError(err: Error) {
    console.error(err);
  }
}

export default TiffPixelSource;