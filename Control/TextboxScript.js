function Accept() {
    var input_message = document.getElementById("input_message").value;
    input_message = "はじめまして「" + input_message + "」さん";
    document.getElementById("output_message").innerHTML = input_message;
}
