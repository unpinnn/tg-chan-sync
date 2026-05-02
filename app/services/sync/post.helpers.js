const { createPostMappingHelpers } = require("./post-mapping.helpers");
const { createPostRangeHelpers } = require("./post-range.helpers");
const { createPostSendHelpers } = require("./post-send.helpers");

function createPostHelpers(deps = {}) {
  const mappingHelpers = createPostMappingHelpers();
  const rangeHelpers = createPostRangeHelpers({
    START_FROM_ID: deps.START_FROM_ID,
    END_AT_ID: deps.END_AT_ID,
    START_FROM_COUNT: deps.START_FROM_COUNT,
    END_AT_COUNT: deps.END_AT_COUNT,
    START_FROM_DATE: deps.START_FROM_DATE,
    START_FROM_DATE_MS: deps.START_FROM_DATE_MS,
    END_AT_DATE: deps.END_AT_DATE,
    END_AT_DATE_MS: deps.END_AT_DATE_MS,
    activeScopeRef: deps.activeScopeRef,
    normalizeDate: deps.normalizeDate
  });
  const sendHelpers = createPostSendHelpers({
    DRY_RUN: deps.DRY_RUN,
    MAX_MEDIA_CAPTION_LENGTH: deps.MAX_MEDIA_CAPTION_LENGTH,
    MAX_TEXT_MESSAGE_LENGTH: deps.MAX_TEXT_MESSAGE_LENGTH,
    withFloodWaitRetry: deps.withFloodWaitRetry,
    downloadMessageMedia: deps.downloadMessageMedia,
    prepareUploadFileInput: deps.prepareUploadFileInput,
    shouldForceDocumentForReupload: deps.shouldForceDocumentForReupload
  });

  return {
    ...mappingHelpers,
    ...rangeHelpers,
    ...sendHelpers
  };
}

module.exports = {
  createPostHelpers
};
