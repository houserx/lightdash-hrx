/**
 * Loads a module through a non-literal specifier so this folder typechecks before the
 * feature it tests exists. Relative specifiers resolve from this folder.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const load = async (specifier: string): Promise<any> =>
    import(/* @vite-ignore */ specifier);
