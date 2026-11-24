"use client";

import { VisualOutputCard } from "@/components/artifacts/visual-card";

/**
 * The question's optional SVG figure (owner, 2026-10-27), shared by the dock
 * and the answered card. It sits in the question column, between the label
 * row and the question text (owner, 2026-11-24), so the adaptive question
 * layout sizes it as question media. No figure renders nothing.
 */
export function QuestionFigure({ figure }: { figure?: unknown }) {
	if (typeof figure !== "string" || !figure) return null;
	return (
		<div data-testid="question-figure" className="mb-3">
			<VisualOutputCard output={{ svg: figure }} />
		</div>
	);
}
