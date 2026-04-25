import { type ConfigResolveData, type ConfigResolveAnnotated } from '../../config/resolve-data.js';

/**
 * Detect whether the data is in the annotated `--show-source` shape.
 * We check for `profile.value` as a discriminant.
 */
function isAnnotated(data: ConfigResolveData): data is ConfigResolveAnnotated {
  return (
    typeof data.profile === 'object' && data.profile !== null && 'value' in (data.profile as object)
  );
}

/**
 * Human renderer for `freelo config resolve`.
 * Renders labelled rows. Under `--show-source`, each row appends `(source: <s>)`.
 * `apiKey` is always rendered as `[redacted]`.
 */
export function renderConfigResolveHuman(data: ConfigResolveData): string {
  if (isAnnotated(data)) {
    const lines = [
      `profile:       ${data.profile.value} (source: ${data.profile.source})`,
      `profileSource: ${data.profileSource.value} (source: ${data.profileSource.source})`,
      `email:         ${data.email.value} (source: ${data.email.source})`,
      `apiKey:        [redacted] (source: ${data.apiKey.source})`,
      `apiBaseUrl:    ${data.apiBaseUrl.value} (source: ${data.apiBaseUrl.source})`,
      `userAgent:     ${data.userAgent.value} (source: ${data.userAgent.source})`,
      `output.mode:   ${data.output.mode.value} (source: ${data.output.mode.source})`,
      `output.color:  ${data.output.color.value} (source: ${data.output.color.source})`,
      `verbose:       ${String(data.verbose.value)} (source: ${data.verbose.source})`,
      `yes:           ${String(data.yes.value)} (source: ${data.yes.source})`,
      `requestId:     ${data.requestId.value} (source: ${data.requestId.source})`,
      `has_token:     ${String(data.has_token.value)}`,
    ];
    return lines.join('\n');
  }

  // Flat shape
  const lines = [
    `profile:       ${data.profile}`,
    `profileSource: ${data.profileSource}`,
    `email:         ${data.email}`,
    `apiKey:        [redacted]`,
    `apiBaseUrl:    ${data.apiBaseUrl}`,
    `userAgent:     ${data.userAgent}`,
    `output.mode:   ${data.output.mode}`,
    `output.color:  ${data.output.color}`,
    `verbose:       ${String(data.verbose)}`,
    `yes:           ${String(data.yes)}`,
    `requestId:     ${data.requestId}`,
    `has_token:     ${String(data.has_token)}`,
  ];
  return lines.join('\n');
}
