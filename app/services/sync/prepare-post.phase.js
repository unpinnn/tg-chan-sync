const { runPreparePass } = require("./prepare.phase");
const { runPostingPass } = require("./post.phase");

async function runPrepareAndPosting(deps = {}) {
  let copied = Number(deps.copied || 0);
  let skipped = Number(deps.skipped || 0);
  let skippedExisting = Number(deps.skippedExisting || 0);
  let prepareAddedUnits = Number(deps.prepareAddedUnits || 0);
  let prepareAddedMessages = Number(deps.prepareAddedMessages || 0);
  let prepareSkippedUnits = Number(deps.prepareSkippedUnits || 0);
  let prepareSkippedMessages = Number(deps.prepareSkippedMessages || 0);
  let progressMessages = Number(deps.progressMessages || 0);
  const preparedUnits = deps.preparedUnits || [];

  const prepareResult = await runPreparePass({
    ...deps,
    prepareAddedMessages,
    prepareAddedUnits,
    prepareSkippedMessages,
    prepareSkippedUnits,
    progressMessages,
    skipped,
    skippedExisting
  });
  skipped = prepareResult.skipped;
  skippedExisting = prepareResult.skippedExisting;
  prepareAddedUnits = prepareResult.prepareAddedUnits;
  prepareAddedMessages = prepareResult.prepareAddedMessages;
  prepareSkippedUnits = prepareResult.prepareSkippedUnits;
  prepareSkippedMessages = prepareResult.prepareSkippedMessages;
  progressMessages = prepareResult.progressMessages;

  const postResult = await runPostingPass({
    ...deps,
    copied,
    preparedUnits,
    skipped
  });
  copied = postResult.copied;
  skipped = postResult.skipped;

  return {
    copied,
    preparedUnits,
    prepareAddedMessages,
    prepareAddedUnits,
    prepareSkippedMessages,
    prepareSkippedUnits,
    progressMessages,
    skipped,
    skippedExisting
  };
}

module.exports = {
  runPrepareAndPosting
};
