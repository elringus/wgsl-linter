/** Returns the offsets of the line starts in the text. */
export function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}

/** Returns the 0-based line and column of the offset. */
export function position(lines: readonly number[], offset: number): [number, number] {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lines[mid]! <= offset) low = mid;
        else high = mid - 1;
    }
    return [low, offset - lines[low]!];
}
