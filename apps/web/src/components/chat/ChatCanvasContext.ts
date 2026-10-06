import { createContext, useContext } from "react";
import type { ChatCanvasPreview, resolveChatCanvasLayout } from "./chatCanvasLayout";
import type { PreviewMiniPlayerObstacles } from "../preview/previewMiniPlayerLayout";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  previewKey: string | null;
  reportPreview: (preview: ChatCanvasPreview) => void;
  clearPreview: (key: string) => void;
  registerTimeline: (element: HTMLElement | null) => void;
  reportDetailsCard: (card: PreviewMiniPlayerObstacles["detailsCard"]) => void;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);

/**
 * The canvas's callbacks alone. They never change, so a consumer that only
 * registers or reports does not re-render each frame the canvas resizes (a
 * sidebar or panel animating open beside it).
 */
export const ChatCanvasActionsContext = createContext<{
  registerTimeline: (element: HTMLElement | null) => void;
} | null>(null);

export const useChatCanvasActions = () => useContext(ChatCanvasActionsContext);
