// Minimal ambient types for the slice of `pngjs` we use. The package ships no
// type definitions; we declare only what relay (and its tests) touch rather than
// pulling in the full `@types/pngjs` dev dependency.
declare module "pngjs" {
  export class PNG {
    constructor(options?: { width: number; height: number });
    width: number;
    height: number;
    /** Raw RGBA pixel data, 4 bytes per pixel, row-major. */
    data: Buffer;
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}
