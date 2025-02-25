$(document).ready(function () {
    const formInputs = $('input[type="text"], input[type="password"], input[type="date"], input[type="time"], textarea');

    formInputs.on('focus', function () {
        // Reset animation by removing and re-adding the class
        $(this).css('animation', 'none');
        setTimeout(() => $(this).css('animation', 'pulse 1.5s infinite ease-in-out'), 10);

        $(this).parent().children('p.formLabel').addClass('formTop');
        $('#formWrapper').addClass('darken-bg');
        $('.logo').addClass('logo-active');
    });

    formInputs.on('focusout', function () {
        if ($.trim($(this).val()).length === 0) {
            $(this).parent().children('p.formLabel').removeClass('formTop');
        }
        $('#formWrapper').removeClass('darken-bg');
        $('.logo').removeClass('logo-active');
    });

    $('p.formLabel').click(function () {
        $(this).parent().children('.form-style').focus();
    });
});
