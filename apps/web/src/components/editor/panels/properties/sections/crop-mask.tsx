import { NumberField } from "@/components/ui/number-field";
import { useEditor } from "@/hooks/use-editor";
import type { VisualElement } from "@/types/timeline";
import type { CropRect, MaskShape } from "@/types/rendering";
import {
	getDefaultMaskShape,
	resolveMaskShape,
	MAX_MASK_DIMENSION,
	MIN_MASK_DIMENSION,
} from "@/lib/effects/definitions/shape-mask";
import {
	createDefaultCustomMask,
	resolveCustomMask,
} from "@/lib/effects/definitions/custom-mask";
import {
	createDefaultTextMask,
	resolveTextMask,
} from "@/lib/effects/definitions/text-mask";
import {
	getClosedStateAfterPointRemoval,
	removeFreeformPathPoints,
} from "@/lib/effects/masks/freeform-path";
import { usePenMaskStore } from "@/stores/pen-mask-store";
import { FontPicker } from "@/components/ui/font-picker";
import { Textarea } from "@/components/ui/textarea";
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from "@/constants/text-constants";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "../section";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { CropIcon, Cancel01Icon } from "@hugeicons/core-free-icons";

const MASK_SHAPES: { type: MaskShape["type"]; label: string }[] = [
	{ type: "rectangle", label: "Rect" },
	{ type: "ellipse", label: "Ellipse" },
	{ type: "star", label: "Star" },
	{ type: "heart", label: "Heart" },
	{ type: "diamond", label: "Diamond" },
	{ type: "split", label: "Split" },
	{ type: "cinematic-bars", label: "Bars" },
	{ type: "custom", label: "Pen" },
	{ type: "text", label: "Text" },
];

const MASK_FONT_WEIGHTS: { value: "normal" | "bold"; label: string }[] = [
	{ value: "normal", label: "Regular" },
	{ value: "bold", label: "Bold" },
];

export function CropMaskSection({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const drawingElementId = usePenMaskStore((s) => s.drawingElementId);
	const selectedPointIds = usePenMaskStore((s) => s.selectedPointIds);
	const toggleDrawing = usePenMaskStore((s) => s.toggleDrawing);
	const startDrawing = usePenMaskStore((s) => s.startDrawing);
	const stopDrawing = usePenMaskStore((s) => s.stopDrawing);
	const setSelectedPoints = usePenMaskStore((s) => s.setSelectedPoints);

	const crop = element.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
	const mask = element.mask;
	const isCustom = mask?.type === "custom";
	const isText = mask?.type === "text";
	const resolvedMask =
		mask && !isCustom && !isText ? resolveMaskShape({ mask }) : null;
	const customMask = mask && isCustom ? resolveCustomMask({ mask }) : null;
	const textMask = mask && isText ? resolveTextMask({ mask }) : null;
	const isDrawing = drawingElementId === element.id;

	const updateCrop = (updates: Partial<CropRect>) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						crop: { ...crop, ...updates },
					},
				},
			],
		});
	};

	const updateMask = (updates: Partial<MaskShape>) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						mask: mask
							? { ...mask, ...updates }
							: { ...getDefaultMaskShape({ type: "rectangle" }), ...updates },
					},
				},
			],
		});
	};

	const setMaskShape = (type: MaskShape["type"]) => {
		if (type === "custom") {
			if (!mask || mask.type !== "custom") {
				editor.timeline.updateElements({
					updates: [
						{
							trackId,
							elementId: element.id,
							updates: {
								mask: {
									...createDefaultCustomMask(),
									feather: mask?.feather ?? 0,
									inverted: mask?.inverted ?? false,
								},
							},
						},
					],
				});
			}
			startDrawing(element.id);
			return;
		}

		if (type === "text") {
			stopDrawing();
			if (!mask || mask.type !== "text") {
				editor.timeline.updateElements({
					updates: [
						{
							trackId,
							elementId: element.id,
							updates: {
								mask: {
									...createDefaultTextMask(),
									feather: mask?.feather ?? 0,
									inverted: mask?.inverted ?? false,
								},
							},
						},
					],
				});
			}
			return;
		}

		stopDrawing();
		// Bars use a different default geometry, so reset size when switching to
		// or from them; also always reset when leaving the pen or text tools so
		// their non-analytic fields don't leak onto an analytic shape.
		const shouldResetGeometry =
			!mask ||
			mask.type === "custom" ||
			mask.type === "text" ||
			(mask.type === "cinematic-bars") !== (type === "cinematic-bars");
		const nextMask: MaskShape = shouldResetGeometry
			? {
					...getDefaultMaskShape({ type }),
					feather: mask?.feather ?? 0,
					inverted: mask?.inverted ?? false,
				}
			: { ...mask, type };
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { mask: nextMask },
				},
			],
		});
	};

	const closePenPath = () => {
		if (!mask || !customMask || customMask.points.length < 3) return;
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { mask: { ...mask, closed: true } },
				},
			],
		});
		stopDrawing();
	};

	const deleteSelectedPenPoints = () => {
		if (!mask || !customMask || selectedPointIds.length === 0) return;
		const nextPoints = removeFreeformPathPoints({
			points: customMask.points,
			pointIds: selectedPointIds,
		});
		if (nextPoints.length === customMask.points.length) return;
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						mask: {
							...mask,
							points: nextPoints,
							closed: getClosedStateAfterPointRemoval({
								wasClosed: customMask.closed,
								remainingPointCount: nextPoints.length,
							}),
						},
					},
				},
			],
		});
		setSelectedPoints([]);
	};

	const removeMask = () => {
		stopDrawing();
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { mask: undefined } as Partial<VisualElement>,
				},
			],
		});
	};

	const resetCrop = () => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { crop: undefined } as Partial<VisualElement>,
				},
			],
		});
	};

	return (
		<>
			<Section collapsible sectionKey={`${element.type}:crop`} showTopBorder>
				<SectionHeader>
					<SectionTitle>Crop</SectionTitle>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-6"
						onClick={resetCrop}
						title="Reset crop"
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
					</Button>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<div className="grid grid-cols-2 gap-2">
							<SectionField label="Top">
								<NumberField
									value={crop.top.toString()}
									onChange={(e) => {
										const n = parseFloat(e.target.value);
										if (!isNaN(n)) updateCrop({ top: Math.max(0, n) });
									}}
									onBlur={() => {}}
									min={0}
									step={1}
								/>
							</SectionField>
							<SectionField label="Bottom">
								<NumberField
									value={crop.bottom.toString()}
									onChange={(e) => {
										const n = parseFloat(e.target.value);
										if (!isNaN(n)) updateCrop({ bottom: Math.max(0, n) });
									}}
									onBlur={() => {}}
									min={0}
									step={1}
								/>
							</SectionField>
							<SectionField label="Left">
								<NumberField
									value={crop.left.toString()}
									onChange={(e) => {
										const n = parseFloat(e.target.value);
										if (!isNaN(n)) updateCrop({ left: Math.max(0, n) });
									}}
									onBlur={() => {}}
									min={0}
									step={1}
								/>
							</SectionField>
							<SectionField label="Right">
								<NumberField
									value={crop.right.toString()}
									onChange={(e) => {
										const n = parseFloat(e.target.value);
										if (!isNaN(n)) updateCrop({ right: Math.max(0, n) });
									}}
									onBlur={() => {}}
									min={0}
									step={1}
								/>
							</SectionField>
						</div>
					</SectionFields>
				</SectionContent>
			</Section>

			<Section collapsible sectionKey={`${element.type}:mask`} showTopBorder>
				<SectionHeader>
					<SectionTitle>Mask</SectionTitle>
					{mask && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-6"
							onClick={removeMask}
							title="Remove mask"
						>
							<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
						</Button>
					)}
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<SectionField label="Shape">
							<div className="flex flex-wrap gap-1">
								{MASK_SHAPES.map((shape) => (
									<Button
										key={shape.type}
										type="button"
										variant={mask?.type === shape.type ? "secondary" : "ghost"}
										size="sm"
										className="h-7 min-w-[3.5rem] flex-1 basis-[30%] text-[10px]"
										onClick={() => setMaskShape(shape.type)}
									>
										{shape.label}
									</Button>
								))}
							</div>
						</SectionField>
						{mask && resolvedMask && (
							<>
								<div className="grid grid-cols-2 gap-2">
									<SectionField label="X">
										<NumberField
											value={(resolvedMask.centerX * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														centerX: Math.max(-100, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={-100}
											max={100}
											step={1}
										/>
									</SectionField>
									<SectionField label="Y">
										<NumberField
											value={(resolvedMask.centerY * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														centerY: Math.max(-100, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={-100}
											max={100}
											step={1}
										/>
									</SectionField>
									{resolvedMask.type !== "cinematic-bars" &&
										resolvedMask.type !== "split" && (
											<SectionField label="Width">
												<NumberField
													value={(resolvedMask.width * 100).toFixed(0)}
													onChange={(e) => {
														const n = parseFloat(e.target.value);
														if (!isNaN(n))
															updateMask({
																width:
																	Math.max(
																		MIN_MASK_DIMENSION * 100,
																		Math.min(MAX_MASK_DIMENSION * 100, n),
																	) / 100,
															});
													}}
													onBlur={() => {}}
													min={MIN_MASK_DIMENSION * 100}
													max={MAX_MASK_DIMENSION * 100}
													step={1}
												/>
											</SectionField>
										)}
									{resolvedMask.type !== "split" && (
										<SectionField label="Height">
											<NumberField
												value={(resolvedMask.height * 100).toFixed(0)}
												onChange={(e) => {
													const n = parseFloat(e.target.value);
													if (!isNaN(n))
														updateMask({
															height:
																Math.max(
																	MIN_MASK_DIMENSION * 100,
																	Math.min(MAX_MASK_DIMENSION * 100, n),
																) / 100,
														});
												}}
												onBlur={() => {}}
												min={MIN_MASK_DIMENSION * 100}
												max={MAX_MASK_DIMENSION * 100}
												step={1}
											/>
										</SectionField>
									)}
									<SectionField label="Rotation">
										<NumberField
											value={resolvedMask.rotation.toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														rotation: Math.max(-180, Math.min(180, n)),
													});
											}}
											onBlur={() => {}}
											min={-180}
											max={180}
											step={1}
										/>
									</SectionField>
									<SectionField label="Feather">
										<NumberField
											value={(resolvedMask.feather * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														feather: Math.max(0, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={0}
											max={100}
											step={1}
										/>
									</SectionField>
								</div>
								<SectionField label="Invert">
									<Button
										type="button"
										variant={resolvedMask.inverted ? "secondary" : "ghost"}
										size="sm"
										className="h-7 text-[10px]"
										onClick={() =>
											updateMask({ inverted: !resolvedMask.inverted })
										}
									>
										{resolvedMask.inverted ? "Inverted" : "Normal"}
									</Button>
								</SectionField>
							</>
						)}
						{isCustom && customMask && (
							<>
								<SectionField label="Path">
									<div className="flex flex-wrap gap-1">
										<Button
											type="button"
											variant={isDrawing ? "secondary" : "ghost"}
											size="sm"
											className="h-7 flex-1 text-[10px]"
											onClick={() => toggleDrawing(element.id)}
										>
											{isDrawing ? "Done" : "Draw"}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-7 flex-1 text-[10px]"
											onClick={closePenPath}
											disabled={
												customMask.points.length < 3 || customMask.closed
											}
										>
											Close
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-7 flex-1 text-[10px]"
											onClick={deleteSelectedPenPoints}
											disabled={selectedPointIds.length === 0}
										>
											Delete pt
										</Button>
									</div>
								</SectionField>
								<p className="px-1 text-[10px] text-muted-foreground">
									{customMask.points.length} point
									{customMask.points.length === 1 ? "" : "s"}
									{customMask.closed
										? " · closed"
										: isDrawing
											? " · click canvas to add, click the first point to close"
											: " · open (not yet rendering)"}
								</p>
								<div className="grid grid-cols-2 gap-2">
									<SectionField label="Rotation">
										<NumberField
											value={customMask.rotation.toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														rotation: Math.max(-180, Math.min(180, n)),
													});
											}}
											onBlur={() => {}}
											min={-180}
											max={180}
											step={1}
										/>
									</SectionField>
									<SectionField label="Scale">
										<NumberField
											value={(customMask.scale * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														scale: Math.max(10, Math.min(500, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={10}
											max={500}
											step={1}
										/>
									</SectionField>
									<SectionField label="Feather">
										<NumberField
											value={(customMask.feather * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!isNaN(n))
													updateMask({
														feather: Math.max(0, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={0}
											max={100}
											step={1}
										/>
									</SectionField>
								</div>
								<SectionField label="Invert">
									<Button
										type="button"
										variant={customMask.inverted ? "secondary" : "ghost"}
										size="sm"
										className="h-7 text-[10px]"
										onClick={() =>
											updateMask({ inverted: !customMask.inverted })
										}
									>
										{customMask.inverted ? "Inverted" : "Normal"}
									</Button>
								</SectionField>
							</>
						)}
						{isText && textMask && (
							<>
								<SectionField label="Text">
									<Textarea
										placeholder="Text"
										value={textMask.text}
										className="min-h-16 text-sm"
										onChange={(e) => updateMask({ text: e.target.value })}
									/>
								</SectionField>
								<SectionField label="Font">
									<FontPicker
										defaultValue={textMask.fontFamily}
										onValueChange={(value) => updateMask({ fontFamily: value })}
									/>
								</SectionField>
								<div className="grid grid-cols-2 gap-2">
									<SectionField label="Size">
										<NumberField
											value={textMask.fontSize.toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!Number.isNaN(n))
													updateMask({
														fontSize: Math.max(
															MIN_FONT_SIZE,
															Math.min(MAX_FONT_SIZE, n),
														),
													});
											}}
											onBlur={() => {}}
											min={MIN_FONT_SIZE}
											max={MAX_FONT_SIZE}
											step={1}
										/>
									</SectionField>
									<SectionField label="Weight">
										<div className="flex gap-1">
											{MASK_FONT_WEIGHTS.map((weight) => (
												<Button
													key={weight.value}
													type="button"
													variant={
														textMask.fontWeight === weight.value
															? "secondary"
															: "ghost"
													}
													size="sm"
													className="h-7 flex-1 text-[10px]"
													onClick={() =>
														updateMask({ fontWeight: weight.value })
													}
												>
													{weight.label}
												</Button>
											))}
										</div>
									</SectionField>
									<SectionField label="X">
										<NumberField
											value={(textMask.centerX * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!Number.isNaN(n))
													updateMask({
														centerX: Math.max(-100, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={-100}
											max={100}
											step={1}
										/>
									</SectionField>
									<SectionField label="Y">
										<NumberField
											value={(textMask.centerY * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!Number.isNaN(n))
													updateMask({
														centerY: Math.max(-100, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={-100}
											max={100}
											step={1}
										/>
									</SectionField>
									<SectionField label="Rotation">
										<NumberField
											value={textMask.rotation.toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!Number.isNaN(n))
													updateMask({
														rotation: Math.max(-180, Math.min(180, n)),
													});
											}}
											onBlur={() => {}}
											min={-180}
											max={180}
											step={1}
										/>
									</SectionField>
									<SectionField label="Feather">
										<NumberField
											value={(textMask.feather * 100).toFixed(0)}
											onChange={(e) => {
												const n = parseFloat(e.target.value);
												if (!Number.isNaN(n))
													updateMask({
														feather: Math.max(0, Math.min(100, n)) / 100,
													});
											}}
											onBlur={() => {}}
											min={0}
											max={100}
											step={1}
										/>
									</SectionField>
								</div>
								<SectionField label="Invert">
									<Button
										type="button"
										variant={textMask.inverted ? "secondary" : "ghost"}
										size="sm"
										className="h-7 text-[10px]"
										onClick={() => updateMask({ inverted: !textMask.inverted })}
									>
										{textMask.inverted ? "Inverted" : "Normal"}
									</Button>
								</SectionField>
							</>
						)}
					</SectionFields>
				</SectionContent>
			</Section>
		</>
	);
}
