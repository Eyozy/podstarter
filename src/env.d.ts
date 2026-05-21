/// <reference types="astro/client" />

declare module "qrcode" {
  type QRCodeColorOptions = {
    dark?: string;
    light?: string;
  };

  type QRCodeToCanvasOptions = {
    width?: number;
    margin?: number;
    color?: QRCodeColorOptions;
  };

  const QRCode: {
    toCanvas(
      canvasElement: HTMLCanvasElement,
      text: string,
      options?: QRCodeToCanvasOptions,
      callback?: (error: Error | null | undefined) => void,
    ): Promise<void>;
  };

  export default QRCode;
}
