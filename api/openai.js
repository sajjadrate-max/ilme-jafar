.then(function(res){
    return res.json();
}).then(function(d){

    aiDiv.innerHTML = "";

    var text = "";

    try {
        text =
            d.output_text ||
            d.output?.[0]?.content?.[0]?.text ||
            "";
    } catch (e) {
        text = "";
    }

    if (!text) {
        console.log("OpenAI Response:", d);
        showFallback(aiDiv, ext, q);
        return;
    }

    var parts = text.split("===");
