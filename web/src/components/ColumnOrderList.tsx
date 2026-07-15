// The "Shown (drag to reorder)" list in the column picker. Renders the visible
// metadata columns in table order and lets the user drag them into a new order
// (or nudge with the ↑/↓ keyboard buttons); the table follows. Show/hide stays
// in the sibling checkbox catalogue — this list is purely about sequence.
//
// Built on @dnd-kit: a vertical SortableContext with a keyboard sensor so the
// list is operable without a pointer (grab a handle, arrow to move, space to
// drop). Reordering is committed to the parent via onReorder(nextOrder), which
// feeds useColumnPrefs.reorder.

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DragHandleIcon } from "./Icons";

interface RowProps {
  col: string;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
}

function SortableRow({ col, index, count, onMove }: RowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col });
  return (
    <li
      ref={setNodeRef}
      className={"order-item" + (isDragging ? " dragging" : "")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* The grip is the drag handle: dnd-kit's listeners live here so a click
          elsewhere on the row (e.g. the nudge buttons) isn't swallowed. */}
      <button
        type="button"
        className="order-grip"
        aria-label={`Reorder ${col}`}
        {...attributes}
        {...listeners}
      >
        <DragHandleIcon />
      </button>
      <span className="order-label" title={col}>
        {col}
      </span>
      {/* Keyboard/click fallback for reordering without a drag — also the
          accessible path on touch devices. Disabled at the ends. */}
      <span className="order-nudge">
        <button
          type="button"
          aria-label={`Move ${col} up`}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move ${col} down`}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
        >
          ↓
        </button>
      </span>
    </li>
  );
}

interface Props {
  // Visible metadata columns in current table order.
  columns: string[];
  // Commit a new full order of the visible columns.
  onReorder: (next: string[]) => void;
}

export function ColumnOrderList({ columns, onReorder }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A small activation distance so a plain click on the grip (or the nudge
      // buttons) isn't misread as a drag.
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length || from === to) return;
    onReorder(arrayMove(columns, from, to));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = columns.indexOf(String(active.id));
    const to = columns.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(columns, from, to));
  };

  if (columns.length === 0) {
    return <div className="order-empty">No columns shown.</div>;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={columns} strategy={verticalListSortingStrategy}>
        <ul className="order-list">
          {columns.map((col, i) => (
            <SortableRow
              key={col}
              col={col}
              index={i}
              count={columns.length}
              onMove={move}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
