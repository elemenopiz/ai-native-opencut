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
];

export function CropMaskSection({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const crop = element.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
	const mask = element.mask;
	const resolvedMask = mask ? resolveMaskShape({ mask }) : null;

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
		// Bars use a different default geometry, so reset size when
		// switching to or from them; otherwise keep the current geometry.
		const shouldResetGeometry =
			!mask || (mask.type === "cinematic-bars") !== (type === "cinematic-bars");
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

	const removeMask = () => {
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
												if (!isNaN(n)) updateMask({ centerX: Math.max(-100, Math.min(100, n)) / 100 });
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
												if (!isNaN(n)) updateMask({ centerY: Math.max(-100, Math.min(100, n)) / 100 });
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
												if (!isNaN(n)) updateMask({ rotation: Math.max(-180, Math.min(180, n)) });
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
												if (!isNaN(n)) updateMask({ feather: Math.max(0, Math.min(100, n)) / 100 });
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
										onClick={() => updateMask({ inverted: !resolvedMask.inverted })}
									>
										{resolvedMask.inverted ? "Inverted" : "Normal"}
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
