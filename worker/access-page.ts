export function accessPage(status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Galactic receipt scanner · Private instance</title></head><body><main><h1>Galactic receipt scanner</h1><h2>${status === 401 ? "Sign in to your scanner" : "This scanner belongs to another account"}</h2><p>This is a private receipt capture station. Only its owner can open the camera or view saved receipts.</p><p>${status === 401 ? "Sign in with the account that owns this instance to continue." : "If you have another account, sign out and choose the account that owns this scanner."}</p><p><a href="/signout-with-chatgpt">Sign out and choose another account</a></p><h2>Set up your own scanner</h2><p>The source code and setup guide are available on GitHub.</p><p><a href="https://github.com/oana-ffg/galactic-receipt-scanner" rel="noreferrer">View the project on GitHub</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
