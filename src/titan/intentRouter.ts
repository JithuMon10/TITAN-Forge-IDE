export type Intent =
  | { kind: "greeting" }
  | { kind: "identity" }
  | { kind: "smalltalk" }
  | { kind: "unknown" };

export function routeIntent(input: string): Intent {
  const text = input.trim().toLowerCase();

  if (/^(hi|hello|hey)\b/.test(text)) return { kind: "greeting" };
  if (/who are you|what are you/.test(text)) return { kind: "identity" };
  if (/how are you|what'?s up/.test(text)) return { kind: "smalltalk" };

  return { kind: "unknown" };
}
