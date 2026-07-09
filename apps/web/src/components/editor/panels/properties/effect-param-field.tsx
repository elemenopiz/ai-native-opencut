"use client";

import { useRef } from "react";
import { toast } from "sonner";
import type {
	EffectParamDefinition,
	NumberEffectParamDefinition,
} from "@/types/effects";
import { clamp } from "@/utils/math";
import { cubeTextToLutParam } from "@/lib/color/cube-lut";
import { SectionField } from "./section";
import { Slider } from "@/components/ui/slider";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { usePropertyDraft } from "./hooks/use-property-draft";
import { ColorWheel } from "./color-wheel";

export function EffectParamField({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: EffectParamDefinition;
	value: number | string | boolean;
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
}) {
	// Color wheels need a wider, stacked layout instead of the label/field row.
	if (param.type === "wheel") {
		return (
			<div className="flex flex-col items-center gap-1.5 py-1">
				<span className="text-[11px] text-muted-foreground">{param.label}</span>
				<ColorWheel
					value={typeof value === "string" ? value : param.default}
					onPreview={onPreview}
					onCommit={onCommit}
				/>
			</div>
		);
	}

	// LUT slots render a file picker + the loaded LUT name in a stacked layout.
	if (param.type === "lut") {
		return (
			<div className="flex flex-col gap-1.5 py-1">
				<span className="text-[11px] text-muted-foreground">{param.label}</span>
				<LutParamField
					value={typeof value === "string" ? value : ""}
					onPreview={onPreview}
					onCommit={onCommit}
				/>
			</div>
		);
	}

	return (
		<SectionField label={param.label}>
			<EffectParamInput
				param={param}
				value={value}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		</SectionField>
	);
}

function EffectParamInput({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: EffectParamDefinition;
	value: number | string | boolean;
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
}) {
	if (param.type === "number") {
		return (
			<NumberParamField
				param={param}
				value={typeof value === "number" ? value : Number(value)}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		);
	}

	if (param.type === "boolean") {
		return (
			<Switch
				checked={Boolean(value)}
				onCheckedChange={(checked) => {
					onPreview(checked);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "select") {
		return (
			<Select
				value={String(value)}
				onValueChange={(selected) => {
					onPreview(selected);
					onCommit();
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{param.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	if (param.type === "color") {
		return (
			<input
				type="color"
				className="h-8 w-full cursor-pointer rounded border"
				value={String(value)}
				onChange={(event) => onPreview(event.target.value)}
				onBlur={onCommit}
			/>
		);
	}

	return null;
}

function NumberParamField({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: NumberEffectParamDefinition;
	value: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
}) {
	const { min, max, step } = param;

	const draft = usePropertyDraft({
		displayValue: String(value),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clamp({ value: parsed, min, max });
		},
		onPreview,
		onCommit,
	});

	return (
		<div className="flex items-center gap-3">
			<Slider
				className="flex-1"
				min={min}
				max={max}
				step={step}
				value={[value]}
				onValueChange={([newValue]) => onPreview(newValue)}
				onValueCommit={onCommit}
			/>
			<NumberField
				className="w-16 shrink-0"
				value={draft.displayValue}
				onFocus={draft.onFocus}
				onChange={draft.onChange}
				onBlur={draft.onBlur}
			/>
		</div>
	);
}

/** Read the display name out of a serialized LUT param (empty = none loaded). */
function getLoadedLutName(serialized: string): string | null {
	if (serialized.length === 0) return null;
	try {
		const parsed = JSON.parse(serialized) as { name?: string };
		return typeof parsed.name === "string" && parsed.name.length > 0
			? parsed.name
			: "LUT";
	} catch {
		return null;
	}
}

function LutParamField({
	value,
	onPreview,
	onCommit,
}: {
	value: string;
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const loadedName = getLoadedLutName(value);

	const handleFile = async (file: File) => {
		try {
			const text = await file.text();
			const { serialized } = cubeTextToLutParam({ text, fileName: file.name });
			onPreview(serialized);
			onCommit();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to load .cube LUT",
			);
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<input
				ref={inputRef}
				type="file"
				accept=".cube"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					// Reset so re-selecting the same file fires onChange again.
					event.target.value = "";
					if (file) void handleFile(file);
				}}
			/>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="flex-1"
					onClick={() => inputRef.current?.click()}
				>
					{loadedName ? "Replace .cube…" : "Load .cube…"}
				</Button>
				{loadedName ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => {
							onPreview("");
							onCommit();
						}}
					>
						Clear
					</Button>
				) : null}
			</div>
			<span className="truncate text-[11px] text-muted-foreground">
				{loadedName ?? "No LUT loaded"}
			</span>
		</div>
	);
}
