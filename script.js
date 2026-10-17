// Keep the footer year current
document.getElementById("year").textContent = new Date().getFullYear();

// Disable the submit button while a signup is being sent, to avoid double submits
document.querySelectorAll("form.signup").forEach((form) => {
  form.addEventListener("submit", () => {
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Sending…";
  });
});
