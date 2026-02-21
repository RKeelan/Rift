import { Send } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import type { SessionStatus } from "../hooks/useAgentSession.ts";
import "./ChatInput.css";

interface ChatInputProps {
	onSend: (content: string) => void;
	status: SessionStatus;
}

export function ChatInput({ onSend, status }: ChatInputProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [isEmpty, setIsEmpty] = useState(true);
	const disconnected = status !== "connected";

	const resetHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (ta) {
			ta.style.height = "auto";
			ta.style.height = `${ta.scrollHeight}px`;
			setIsEmpty(ta.value.trim().length === 0);
		}
	}, []);

	const handleSubmit = useCallback(
		(e?: FormEvent) => {
			e?.preventDefault();
			const ta = textareaRef.current;
			if (!ta) return;
			const value = ta.value.trim();
			if (!value || disconnected) return;
			onSend(value);
			ta.value = "";
			ta.style.height = "auto";
			setIsEmpty(true);
		},
		[onSend, disconnected],
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	return (
		<form className="chat-input" onSubmit={handleSubmit}>
			<textarea
				ref={textareaRef}
				className="chat-input-textarea"
				placeholder={disconnected ? "Disconnected..." : "Send a message..."}
				disabled={disconnected}
				rows={1}
				onInput={resetHeight}
				onKeyDown={handleKeyDown}
			/>
			<button
				type="submit"
				className="chat-input-send"
				disabled={disconnected || isEmpty}
				aria-label="Send message"
			>
				<Send size={20} />
			</button>
		</form>
	);
}
