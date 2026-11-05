import type { ToastVariant } from "../ui/toast";

type ShowToast = (text: string, variant?: ToastVariant, duration?: number) => void;

type ToastRegistration = {
  readonly callback: ShowToast;
};

let activeToastRegistration: ToastRegistration | null = null;

export function setShowToast(callback: ShowToast): () => void {
  const registration: ToastRegistration = { callback };
  activeToastRegistration = registration;
  return () => {
    if (activeToastRegistration === registration) activeToastRegistration = null;
  };
}

export function showToast(text: string, variant: ToastVariant = "info", duration = 2000): void {
  activeToastRegistration?.callback(text, variant, duration);
}
