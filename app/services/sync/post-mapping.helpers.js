function createPostMappingHelpers() {
  function createLinkRewriteState() {
    return {
      sourceToDestinationId: new Map()
    };
  }

  function groupedIdOf(message) {
    if (message?.groupedId == null) return "";
    return String(message.groupedId);
  }

  function isGroupedPost(messages) {
    if (messages.length <= 1) return false;
    const gid = groupedIdOf(messages[0]);
    if (!gid) return false;
    return messages.every((m) => groupedIdOf(m) === gid);
  }

  function rememberMessageIdMappings(sourceMessages, destinationMessages, linkRewriteState) {
    if (!destinationMessages || destinationMessages.length === 0) {
      return 0;
    }
    let changed = 0;
    const n = Math.min(sourceMessages.length, destinationMessages.length);
    for (let i = 0; i < n; i += 1) {
      const srcId = Number(sourceMessages[i]?.id || 0);
      const dstId = Number(destinationMessages[i]?.id || 0);
      if (srcId > 0 && dstId > 0) {
        const prev = linkRewriteState.sourceToDestinationId.get(srcId);
        linkRewriteState.sourceToDestinationId.set(srcId, dstId);
        if (prev !== dstId) {
          changed += 1;
        }
      }
    }
    return changed;
  }

  return {
    createLinkRewriteState,
    groupedIdOf,
    isGroupedPost,
    rememberMessageIdMappings
  };
}

module.exports = {
  createPostMappingHelpers
};
