import { en, type MessageKey } from "./en";
import { ar } from "./ar";

export type Locale = "en" | "ar";
export const RTL: Locale[] = ["ar"];
export function translate(locale: Locale, key: MessageKey): string {
  return (locale === "ar" ? ar[key] : undefined) ?? en[key];
}
export type { MessageKey };
