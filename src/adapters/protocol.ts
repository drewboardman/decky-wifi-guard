import { GuardFault, issueCode } from "../errors";

export function unwrap(response: unknown): unknown {
  if (!response || typeof response !== "object" || !("ok" in response))
    throw new GuardFault("invalid_response", "Invalid backend response");
  const result = response as {
    ok: unknown;
    value?: unknown;
    error?: unknown;
    error_code?: unknown;
  };
  if (result.ok !== true)
    throw new GuardFault(issueCode(result.error_code), result.error);
  return result.value;
}
