import { memo } from 'react';

import { ResizableHandle } from '@/components/ui/resizable';
import { useSidePanelResize } from '@/hooks/use-side-panel-resize';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';

type SidePanelProps = {
	containerRef: React.RefObject<HTMLDivElement | null>;
	sidePanelRef: React.RefObject<HTMLDivElement | null>;
	resizeHandleRef: React.RefObject<HTMLDivElement | null>;
	children: React.ReactNode;
	isAnimating: boolean;
	className?: string;
};

export const SidePanel = memo(function SidePanel({
	containerRef,
	sidePanelRef,
	resizeHandleRef,
	children,
	isAnimating,
	className,
}: SidePanelProps) {
	const isMobile = useIsMobile();
	useSidePanelResize(sidePanelRef, containerRef, resizeHandleRef, !isAnimating && !isMobile);

	if (isMobile) {
		return (
			<div ref={sidePanelRef} className='fixed inset-0 z-40 bg-background flex flex-col'>
				<div className='flex-1 min-h-0 overflow-hidden'>{children}</div>
			</div>
		);
	}

	return (
		<div ref={sidePanelRef} className={cn('h-full bg-background', className)}>
			<div className='h-full min-w-72 relative flex'>
				<div
					className='h-full relative flex items-center justify-center z-20 w-px cursor-ew-resize'
					ref={resizeHandleRef}
				>
					<ResizableHandle aria-orientation='vertical' className='absolute' />
				</div>

				<div className='h-full overflow-hidden bg-panel shadow-lg border rounded-l-3xl w-full'>
					<div className='bg-background overflow-hidden h-full'>{children}</div>
				</div>
			</div>
		</div>
	);
});
