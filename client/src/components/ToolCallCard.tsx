import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ToolResultMessage, ToolUseMessage } from "shared";
import { DiffViewer, containsUnifiedDiff } from "./DiffViewer.tsx";
import "./ToolCallCard.css";

function summariseTool(tool: string, input: Record<string, unknown>): string {
	const firstKey = Object.keys(input)[0];
	if (!firstKey) return tool;
	const value = input[firstKey];
	const preview =
		typeof value === "string"
			? value.length > 60
				? `${value.slice(0, 60)}...`
				: value
			: String(value);
	return `${tool}: ${preview}`;
}

interface ToolCallCardProps {
	toolUse: ToolUseMessage;
	toolResult?: ToolResultMessage;
}

export function ToolCallCard({ toolUse, toolResult }: ToolCallCardProps) {
	const [expanded, setExpanded] = useState(false);
	const summary = summariseTool(toolUse.tool, toolUse.input);

	return (
		<div className="tool-card">
			<button
				type="button"
				className="tool-card-header"
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
				<span className="tool-card-summary">{summary}</span>
			</button>

			{expanded && (
				<div className="tool-card-body">
					<div className="tool-card-section">
						<div className="tool-card-label">Input</div>
						<pre className="tool-card-json">
							{JSON.stringify(toolUse.input, null, 2)}
						</pre>
					</div>

					{toolResult && (
						<div className="tool-card-section">
							<div className="tool-card-label">
								{toolResult.is_error ? "Error" : "Output"}
							</div>
							{containsUnifiedDiff(toolResult.output) ? (
								<DiffViewer diff={toolResult.output} />
							) : (
								<pre
									className={`tool-card-output ${toolResult.is_error ? "tool-card-error" : ""}`}
								>
									{toolResult.output}
								</pre>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

interface StandaloneToolResultProps {
	toolResult: ToolResultMessage;
}

export function StandaloneToolResult({
	toolResult,
}: StandaloneToolResultProps) {
	return (
		<div className="tool-card standalone">
			<div className="tool-card-body">
				<div className="tool-card-label">
					Tool Result {toolResult.is_error ? "(Error)" : ""}
				</div>
				{containsUnifiedDiff(toolResult.output) ? (
					<DiffViewer diff={toolResult.output} />
				) : (
					<pre
						className={`tool-card-output ${toolResult.is_error ? "tool-card-error" : ""}`}
					>
						{toolResult.output}
					</pre>
				)}
			</div>
		</div>
	);
}
