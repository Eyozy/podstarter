/// <reference types="astro/client" />

interface Window {
  toast?: {
    show: (message: string, type?: "info" | "success" | "warning" | "error", duration?: number) => void;
    success: (message: string, duration?: number) => void;
    error: (message: string, duration?: number) => void;
    warning: (message: string, duration?: number) => void;
    info: (message: string, duration?: number) => void;
  };
}
