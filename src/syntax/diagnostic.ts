export type Severity = "error" | "warning" | "info";

/** A problem found in the source, located with UTF-16 offsets. */
export interface Diagnostic {
    readonly start: number;
    readonly end: number;
    readonly severity: Severity;
    readonly message: string;
    /** Related locations explaining the problem. */
    readonly notes?: readonly Note[];
}

/** A location related to a diagnostic. */
export interface Note {
    readonly start: number;
    readonly end: number;
    readonly message: string;
}
