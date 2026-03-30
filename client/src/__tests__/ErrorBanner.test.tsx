import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
	ErrorBannerProvider,
	useErrorBanner,
} from "../components/ErrorBanner.tsx";

afterEach(cleanup);

/**
 * Helper component that exposes showError via a button so tests can trigger it.
 */
function ErrorTrigger({ message }: { message: string }) {
	const { showError } = useErrorBanner();
	return (
		<button type="button" onClick={() => showError(message)}>
			Trigger Error
		</button>
	);
}

function renderWithProvider(message = "Something went wrong") {
	return render(
		<ErrorBannerProvider>
			<ErrorTrigger message={message} />
		</ErrorBannerProvider>,
	);
}

describe("ErrorBanner", () => {
	test("does not render any banner initially", () => {
		renderWithProvider();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("renders an error banner when showError is called", () => {
		renderWithProvider("Network failure");
		fireEvent.click(screen.getByText("Trigger Error"));
		expect(screen.getByRole("alert")).toBeDefined();
		expect(screen.getByText("Network failure")).toBeDefined();
	});

	test("dismisses the banner when the dismiss button is clicked", () => {
		renderWithProvider("Dismiss me");

		fireEvent.click(screen.getByText("Trigger Error"));
		expect(screen.getByRole("alert")).toBeDefined();

		const dismissButton = screen.getByLabelText("Dismiss error");
		fireEvent.click(dismissButton);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("renders multiple banners when showError is called multiple times", () => {
		renderWithProvider("Error one");

		fireEvent.click(screen.getByText("Trigger Error"));
		fireEvent.click(screen.getByText("Trigger Error"));

		const alerts = screen.getAllByRole("alert");
		expect(alerts.length).toBe(2);
	});
});
