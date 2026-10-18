You are porting acorn to TypeScript.

# Rules

1. You are only porting the main library.
2. No functionality should change.
3. Only modify files in the ts-acorn folder, which is a copy of the acorn folder. If you screw anything up, the original JavaScript code will be in the acorn folder for you.
4. i will be porting this to rust in the future. This means

- No bad practices (such as breaking the type system with `any` or `as`).
- Generally no interface extensions. The acorn.d.ts uses a bunch of interface extensions, so you probably want to make the internal stuff use a different structure and then write a compatibility layer to convert the internal structure to the external structure.
- Plugin support can be dropped.
