import {describe, expect, it} from 'vitest';
import {toSelectedIds} from './datagrid-selection.js';

describe('toSelectedIds', () => {
    it('normalizes DataGrid iterable selection models', () => {
        expect(toSelectedIds({ids: new Set(['group-1', 'group-2'])})).toEqual(['group-1', 'group-2']);
        expect(toSelectedIds({ids: ['group-3']})).toEqual(['group-3']);
        expect(toSelectedIds(new Set(['group-4']))).toEqual(['group-4']);
    });
});
