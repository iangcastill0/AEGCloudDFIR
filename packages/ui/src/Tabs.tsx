'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { nextRovingIndex } from './roving.js';

export interface TabDefinition {
  id: string;
  label: string;
  panel: ReactNode;
}

export interface TabsProps {
  label: string;
  tabs: TabDefinition[];
  activeId?: string;
  onChange?: (id: string) => void;
}

/**
 * WAI-ARIA tabs with a roving tabindex. Arrow keys move focus and select
 * (automatic activation); Home/End jump to the ends.
 */
export function Tabs({ label, tabs, activeId, onChange }: TabsProps) {
  const baseId = useId();
  const [internalActive, setInternalActive] = useState(tabs[0]?.id ?? '');
  const active = activeId ?? internalActive;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === active),
  );
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    if (pendingFocus.current !== null) {
      refs.current[pendingFocus.current]?.focus();
      pendingFocus.current = null;
    }
  });

  function select(index: number, focus: boolean) {
    const tab = tabs[index];
    if (!tab) return;
    setInternalActive(tab.id);
    onChange?.(tab.id);
    if (focus) pendingFocus.current = index;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next = nextRovingIndex(activeIndex, tabs.length, event.key, 'horizontal');
    if (next !== null) {
      event.preventDefault();
      select(next, true);
    }
  }

  const activeTab = tabs[activeIndex];

  return (
    <div className="cdfir-tabs">
      <div role="tablist" aria-label={label} className="cdfir-tabs__list">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={index === activeIndex}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={index === activeIndex ? 0 : -1}
            className="cdfir-tabs__tab"
            ref={(el) => {
              refs.current[index] = el;
            }}
            onClick={() => select(index, false)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${activeTab.id}`}
          aria-labelledby={`${baseId}-tab-${activeTab.id}`}
          tabIndex={0}
        >
          {activeTab.panel}
        </div>
      ) : null}
    </div>
  );
}
