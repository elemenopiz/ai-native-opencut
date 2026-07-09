import { create } from "zustand";

interface BoardStore {
	/** Whether the zoom-out reel board (Phase 6 depth view) is open. */
	open: boolean;
	setOpen: (open: boolean) => void;
	toggle: () => void;
}

export const useBoardStore = create<BoardStore>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
	toggle: () => set((s) => ({ open: !s.open })),
}));
