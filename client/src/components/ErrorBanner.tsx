import { X } from "lucide-react";
import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";

interface ErrorBannerContextValue {
	showError: (message: string) => void;
}

const ErrorBannerContext = createContext<ErrorBannerContextValue>({
	showError: () => {},
});

export function useErrorBanner() {
	return useContext(ErrorBannerContext);
}

export function ErrorBannerProvider({ children }: { children: ReactNode }) {
	const [errors, setErrors] = useState<{ id: number; message: string }[]>([]);
	const nextId = useRef(0);

	const showError = useCallback((message: string) => {
		const id = nextId.current++;
		setErrors((prev) => [...prev, { id, message }]);
		setTimeout(() => {
			setErrors((prev) => prev.filter((e) => e.id !== id));
		}, 8000);
	}, []);

	const dismiss = useCallback((id: number) => {
		setErrors((prev) => prev.filter((e) => e.id !== id));
	}, []);

	return (
		<ErrorBannerContext value={{ showError }}>
			{errors.length > 0 && (
				<div className="error-banner-container">
					{errors.map((error) => (
						<div key={error.id} className="error-banner" role="alert">
							<span className="error-banner-message">{error.message}</span>
							<button
								className="error-banner-dismiss"
								onClick={() => dismiss(error.id)}
								aria-label="Dismiss error"
								type="button"
							>
								<X size={16} />
							</button>
						</div>
					))}
				</div>
			)}
			{children}
		</ErrorBannerContext>
	);
}
