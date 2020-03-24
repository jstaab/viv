export default class TiffPyramidLoader {
  constructor(channelPyramids, pool) {
    this.channelPyramids = channelPyramids;
    this.pool = pool;
    this.type = 'tiff';
    // hardcoded for now
    this.isPyramid = true;
  }

  get vivMetadata() {
    // Get other properties for viewer
    const firstFullImage = this.channelPyramids[0][0].fileDirectory;
    const minZoom = -1 * this.channelPyramids[0].length;
    const imageWidth = firstFullImage.ImageWidth;
    const imageHeight = firstFullImage.ImageLength;
    const tileSize = firstFullImage.TileWidth;
    const bitsPerSample = firstFullImage.BitsPerSample;
    let dtype;
    if (bitsPerSample instanceof Uint8Array) {
      dtype = '<u1';
    }
    if (bitsPerSample instanceof Uint16Array) {
      dtype = '<u2';
    }
    if (bitsPerSample instanceof Uint32Array) {
      dtype = '<u4';
    }
    if (bitsPerSample instanceof Float32Array) {
      dtype = '<f4';
    }
    return {
      minZoom,
      imageWidth,
      imageHeight,
      tileSize,
      dtype
    };
  }

  async getTile({ x, y, z }) {
    const tileRequests = this.channelPyramids.map(channelPyramid => {
      const image = channelPyramid[z];
      return this._getChannel({ image, x, y });
    });
    const tiles = await Promise.all(tileRequests);
    return tiles;
  }

  async getRaster({ z }) {
    const rasterRequests = this.channelPyramids.map(async channelPyramid => {
      const image = channelPyramid[z];
      const raster = await image.readRasters();
      return raster[0];
    });
    const rasters = await Promise.all(rasterRequests);
    return rasters;
  }

  async _getChannel({ image, x, y }) {
    const tile = await image.getTileOrStrip(x, y, 0, this.pool);
    const is8Bits = image.fileDirectory.BitsPerSample[0] === 8;
    const is16Bits = image.fileDirectory.BitsPerSample[0] === 16;
    const is32Bits = image.fileDirectory.BitsPerSample[0] === 32;
    const data =
      (is8Bits && new Uint8Array(tile.data)) ||
      (is16Bits && new Uint16Array(tile.data)) ||
      (is32Bits && new Uint32Array(tile.data));
    return data;
  }
}