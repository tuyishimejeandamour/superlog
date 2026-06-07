export function buildAgentRunInstructions({
  orgInstructions,
  projectContext,
  projectInstructions,
}: {
  orgInstructions: string;
  projectContext: string;
  projectInstructions: string;
}): string {
  const context = projectContext.trim();
  return [
    orgInstructions.trim(),
    context.length > 0 ? `Project context:\n${context}` : "",
    projectInstructions.trim(),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}
