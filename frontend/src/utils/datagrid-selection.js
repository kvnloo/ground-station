export const toSelectedIds = (selectionModel) => {
    if (Array.isArray(selectionModel)) {
        return selectionModel;
    }

    if (selectionModel?.ids && typeof selectionModel.ids[Symbol.iterator] === 'function') {
        return Array.from(selectionModel.ids);
    }

    if (selectionModel && typeof selectionModel[Symbol.iterator] === 'function') {
        return Array.from(selectionModel);
    }

    return [];
};

export const toRowSelectionModel = (selectedIds) => ({
    type: 'include',
    ids: new Set(selectedIds || []),
});
