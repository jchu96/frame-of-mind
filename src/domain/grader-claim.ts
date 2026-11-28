export function escapeEvidence(value:string) {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function quoteClaim(value:string) {
  return escapeEvidence(value).replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4,"0"));
}

export function claimSentence(claim:{summary:string; surface?:string}) {
  return 'The whole-video index flagged: "' + quoteClaim(claim.summary) + '" on ' + quoteClaim(claim.surface || "an unknown surface") + ".";
}
